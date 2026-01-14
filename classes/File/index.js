import axios from "axios"
import fs from "fs"
import path from "path";
import { Transform } from "node:stream"
import { pipeline, finished } from "node:stream/promises"
import crypto from "node:crypto"
import decryptNodeAttributes from "./functions/decryptNodeAttributes.js";
import { aes128EcbDecrypt, xor32hex, b64urlToBuffer } from "../../common/megaCrypto.js"

const PROXY_COOLDOWN_MS = 10 * 60_000
const MAC_CHUNK_BASE = 128 * 1024

const getMacChunkSize = index => (index < 8 ? index + 1 : 8) * MAC_CHUNK_BASE

const aesEncryptBlock = (cipher, block) => cipher.update(block)

const incrementCounter = (counter, blocks) => {
    let carry = BigInt(blocks)
    for (let i = counter.length - 1; i >= 0 && carry > 0n; i--) {
        const sum = BigInt(counter[i]) + (carry & 0xffn)
        counter[i] = Number(sum & 0xffn)
        carry = (carry >> 8n) + (sum >> 8n)
    }
}

const createCtrDecipherForOffset = (key, iv, offset) => {
    const counter = Buffer.from(iv)
    const blockOffset = BigInt(Math.floor(offset / 16))
    incrementCounter(counter, blockOffset)

    const decipher = crypto.createDecipheriv("aes-128-ctr", key, counter)
    const skipBytes = offset % 16
    if (skipBytes > 0) {
        decipher.update(Buffer.alloc(skipBytes))
    }
    return decipher
}

const createMacState = (key, nonce) => {
    const cipher = crypto.createCipheriv("aes-128-ecb", key, null)
    cipher.setAutoPadding(false)
    const macIv = Buffer.concat([nonce, nonce])

    return {
        cipher,
        position: 0,
        chunkIndex: 0,
        nextBoundary: getMacChunkSize(0),
        chunkMacIv: macIv,
        chunkMac: Buffer.from(macIv),
        metaMac: Buffer.alloc(16, 0)
    }
}

const closeMacChunk = state => {
    for (let i = 0; i < 16; i++) {
        state.metaMac[i] ^= state.chunkMac[i]
    }
    state.metaMac = Buffer.from(aesEncryptBlock(state.cipher, state.metaMac))
    state.chunkMac = Buffer.from(state.chunkMacIv)
    state.chunkIndex += 1
    state.nextBoundary += getMacChunkSize(state.chunkIndex)
}

const updateMacState = (state, data) => {
    for (let i = 0; i < data.length; i++) {
        const blockOffset = state.position % 16
        state.chunkMac[blockOffset] ^= data[i]
        state.position += 1

        if (state.position % 16 === 0) {
            state.chunkMac = Buffer.from(aesEncryptBlock(state.cipher, state.chunkMac))
        }

        if (state.position === state.nextBoundary) {
            closeMacChunk(state)
        }
    }
}

const finalizeMacState = state => {
    const blockOffset = state.position % 16
    if (blockOffset !== 0) {
        for (let i = blockOffset; i < 16; i++) {
            state.chunkMac[i] ^= 0
        }
        state.position += 16 - blockOffset
        state.chunkMac = Buffer.from(aesEncryptBlock(state.cipher, state.chunkMac))
    }

    const currentChunkStart = state.nextBoundary - getMacChunkSize(state.chunkIndex)
    if (state.position > currentChunkStart) {
        closeMacChunk(state)
    }

    const mac = Buffer.alloc(8)
    for (let i = 0; i < 4; i++) {
        mac[i] = state.metaMac[i] ^ state.metaMac[i + 4]
        mac[i + 4] = state.metaMac[i + 8] ^ state.metaMac[i + 12]
    }

    state.cipher.final()
    return mac
}

export const verifyFileCbcMac = async (filePath, keyHex, nonceHex, metaMacHex, onProgress = null) => {
    const key = Buffer.from(keyHex, "hex")
    const nonce = Buffer.from(nonceHex, "hex")
    const expectedMac = Buffer.from(metaMacHex, "hex")
    const macState = createMacState(key, nonce)
    const fileSize = fs.statSync(filePath).size

    let processed = 0
    let lastReport = 0

    const readStream = fs.createReadStream(filePath)
    for await (const chunk of readStream) {
        updateMacState(macState, chunk)
        processed += chunk.length

        if (onProgress && (processed - lastReport >= 4 * 1024 * 1024 || processed === fileSize)) {
            lastReport = processed
            onProgress(processed, fileSize)
        }
    }

    const computedMac = finalizeMacState(macState)
    return computedMac.equals(expectedMac)
}

export default class File {
    constructor(node, process) {
        this.process = process
        this.node = node

        const attributes = JSON.parse(decryptNodeAttributes({ a: node.a, k: node.k }, this.process.folderKey))

        const folderRootHandle = node.k.split(':')[0]

        let directoryPath = ''
        let currentParentHandle = node.p

        while (currentParentHandle) {
            const parentNode = this.process.allNodes.find(node => node.h === currentParentHandle)
            const parentAttributesRaw = decryptNodeAttributes({ a: parentNode.a, k: parentNode.k }, this.process.folderKey)
            if (!parentAttributesRaw) break
            const parentAttributes = JSON.parse(parentAttributesRaw)

            const folderName = parentAttributes.n
            directoryPath = `${folderName}/${directoryPath}`

            if (currentParentHandle === folderRootHandle) break

            currentParentHandle = parentNode.p
        }

        this.id = node.h
        this.name = attributes.n
        this.directoryPath = directoryPath
        this.size = node.s
        this.timestamp = node.ts

        this.status = 'waiting'

        this.downloadedBytes = 0
        this.verifyProgress = 0
        this.startedAt = null
        this.lastTickTime = 0
        this.speed = 0
        this.eta = 0
        this.speedSamples = []
    }

    async streamFile(downloadURL, proxy) {
        this.status = 'requesting stream'

        const streamPath = path.join(this.process.downloadDirectory, this.process.flatten ? '' : this.directoryPath, `${this.name}.part`)
        const cryptoParams = this.getFileCryptoParams()

        let startByte = fs.existsSync(streamPath) ? fs.statSync(streamPath).size : 0
        if (startByte > this.size) {
            fs.unlinkSync(streamPath)
            startByte = 0
        }

        this.startByte = startByte
        this.downloadedBytes = startByte
        this.startedAt = Date.now()
        this.lastTickTime = this.startedAt
        this.speedSamples = [{ time: this.startedAt, bytes: this.downloadedBytes }]

        try {
            await this.downloadChunks(downloadURL, proxy, streamPath, cryptoParams)
        } catch (error) {
            this.handleStreamError(error, proxy)
            return
        }

        const finalPath = this.getFinalPath()
        fs.renameSync(streamPath, finalPath)
        this.markVerificationPending()
        this.process.reinsertProxy(proxy, 'working')
        this.process.queueVerification(this, cryptoParams, finalPath)
        this.process.ensureProxyWorkers()
    }

    getFileCryptoParams() {
        const nodeKeyB64 = this.node.k.split(":").at(-1)
        const nodeKeyBytes = b64urlToBuffer(nodeKeyB64)
        const nodeKeyHex = aes128EcbDecrypt(this.process.folderKey, nodeKeyBytes).toString("hex")

        if (nodeKeyHex.length < 64) {
            throw new Error("Invalid node key length for file content")
        }

        const words = []
        for (let i = 0; i < 8; i++) {
            words.push(nodeKeyHex.slice(i * 8, i * 8 + 8))
        }

        const fileKeyHex = xor32hex(words[0], words[4]) + xor32hex(words[1], words[5]) + xor32hex(words[2], words[6]) + xor32hex(words[3], words[7])
        const ivHex = words[4] + words[5] + "00000000" + "00000000"

        return {
            key: Buffer.from(fileKeyHex, "hex"),
            iv: Buffer.from(ivHex, "hex"),
            nonce: Buffer.from(words[4] + words[5], "hex"),
            metaMac: Buffer.from(words[6] + words[7], "hex")
        }
    }

    getFinalPath() {
        return path.join(this.process.downloadDirectory, this.process.flatten ? '' : this.directoryPath, this.name)
    }

    getDownloadedMarkerPath() {
        return path.join(this.process.downloadDirectory, this.process.flatten ? '' : this.directoryPath, `.downloaded.${this.name}`)
    }

    getVerificationMarkerPath() {
        return path.join(this.process.downloadDirectory, this.process.flatten ? '' : this.directoryPath, `.verifying.${this.name}`)
    }

    hasVerificationMarker() {
        return fs.existsSync(this.getVerificationMarkerPath())
    }

    fileExists() {
        return fs.existsSync(this.getFinalPath())
    }

    markVerificationPending() {
        fs.writeFileSync(this.getVerificationMarkerPath(), '')
        this.downloadedBytes = this.size
        this.verifyProgress = 0
        this.status = 'verifying'
    }

    markVerified() {
        if (fs.existsSync(this.getVerificationMarkerPath())) {
            fs.unlinkSync(this.getVerificationMarkerPath())
        }
        fs.writeFileSync(this.getDownloadedMarkerPath(), '')
        this.downloadedBytes = this.size
        this.verifyProgress = this.size
        this.status = 'downloaded'
    }

    clearVerificationMarker() {
        if (fs.existsSync(this.getVerificationMarkerPath())) {
            fs.unlinkSync(this.getVerificationMarkerPath())
        }
    }

    handleVerificationFailure() {
        this.clearVerificationMarker()
        if (this.fileExists()) {
            fs.unlinkSync(this.getFinalPath())
        }
        this.downloadedBytes = 0
        this.verifyProgress = 0
        this.status = 'waiting'
        this.process.ensureProxyWorkers()
    }

    async downloadChunks(downloadURL, proxy, streamPath, cryptoParams) {
        const chunkSize = 256 * 1024 * 1024
        fs.mkdirSync(path.join(this.process.downloadDirectory, this.process.flatten ? '' : this.directoryPath), { recursive: true })

        while (this.downloadedBytes < this.size) {
            const chunkStart = this.downloadedBytes
            const chunkEnd = Math.min(chunkStart + chunkSize - 1, Math.max(this.size - 1, 0))
            const chunkUrl = `${downloadURL}/${chunkStart}-${chunkEnd}`

            const controller = new AbortController()
            const resetTimeout = () => {
                clearTimeout(controller.timeoutId)
                controller.timeoutId = setTimeout(() => {
                    const err = new Error("Stream timeout")
                    err.code = "ETIMEDOUT"
                    controller.abort(err)
                }, 5_000)
            }
            resetTimeout()

            const streamConfig = {
                responseType: "stream",
                headers: {
                    Accept: "*/*",
                    "Accept-Encoding": "deflate, gzip, br, zstd",
                    "Accept-Language": "en-US;q=0.8,en;q=0.3",
                    "Cache-Control": "no-cache",
                    "Content-Type": "application/x-www-form-urlencoded",
                    DNT: "1",
                    Origin: "https://mega.nz",
                    Pragma: "no-cache",
                    Referer: "https://mega.nz/",
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:137.0) Gecko/20100101 Firefox/137.0"
                },
                proxy: false,
                signal: controller.signal
            }

            if (proxy.agent) {
                streamConfig.httpAgent = proxy.agent
                streamConfig.httpsAgent = proxy.agent
            }

            const stream = await axios.post(chunkUrl, null, streamConfig)
            const decipher = createCtrDecipherForOffset(cryptoParams.key, cryptoParams.iv, chunkStart)

            stream.data.once("data", () => this.status = 'downloading')

            const onData = chunk => {
                resetTimeout()
                const now = Date.now()
                this.downloadedBytes += chunk.length

                const deltaTime = (now - this.lastTickTime) / 1000
                if (deltaTime > 0) {
                    this.speedSamples.push({ time: now, bytes: this.downloadedBytes })
                    const windowMs = 30000
                    while (this.speedSamples.length > 1 && now - this.speedSamples[0].time > windowMs) {
                        this.speedSamples.shift()
                    }
                    const oldest = this.speedSamples[0]
                    const newest = this.speedSamples[this.speedSamples.length - 1]
                    const windowTime = (newest.time - oldest.time) / 1000
                    if (windowTime > 0) {
                        this.speed = (newest.bytes - oldest.bytes) / windowTime
                    }
                    const remaining = Math.max(this.size - this.downloadedBytes, 0)
                    const elapsed = (now - this.startedAt) / 1000
                    const bytesDelta = Math.max(this.downloadedBytes - (this.startByte || 0), 0)
                    const avgSpeed = elapsed > 0 ? bytesDelta / elapsed : 0
                    this.eta = avgSpeed > 0 ? remaining / avgSpeed : 0
                }
                this.lastTickTime = now
            }

            stream.data.on("data", onData)

            const decryptStream = new Transform({
                transform: (chunk, _encoding, callback) => {
                    try {
                        const decrypted = decipher.update(chunk)
                        callback(null, decrypted)
                    } catch (error) {
                        callback(error)
                    }
                },
                flush: callback => {
                    try {
                        const final = decipher.final()
                        if (final.length) {
                            decryptStream.push(final)
                        }
                        callback()
                    } catch (error) {
                        callback(error)
                    }
                }
            })

            const writeStream = fs.createWriteStream(streamPath, {
                flags: chunkStart > 0 ? "a" : "w"
            })

            await Promise.all([
                pipeline(stream.data, decryptStream, writeStream),
                finished(stream.data)
            ])

            stream.data.off("data", onData)
            clearTimeout(controller.timeoutId)

            if (this.downloadedBytes <= chunkStart) {
                throw new Error("Stream returned no data")
            }
        }
    }

    handleStreamError(error, proxy) {
        const now = Date.now()
        proxy.lastUsed = now
        proxy.cooldownUntil = now + PROXY_COOLDOWN_MS
        this.process.reinsertProxy(proxy)

        this.status = 'waiting'
        this.process.ensureProxyWorkers()
    }

    alreadyDownloaded() {
        return fs.existsSync(this.getDownloadedMarkerPath())
    }

    async decryptFileContent(inputPath, outputPath, cryptoParams = null) {
        const params = cryptoParams ?? this.getFileCryptoParams()
        const maxAttempts = 3

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const decipher = crypto.createDecipheriv("aes-128-ctr", params.key, params.iv)
            try {
                await pipeline(
                    fs.createReadStream(inputPath),
                    decipher,
                    fs.createWriteStream(outputPath, { flags: "w" })
                )
                return
            } catch (error) {
                if (fs.existsSync(outputPath)) {
                    try {
                        fs.unlinkSync(outputPath)
                    } catch (cleanupError) {
                        if (error?.code !== "EIO" || attempt === maxAttempts) {
                            throw cleanupError
                        }
                    }
                }
                if (error?.code !== "EIO" || attempt === maxAttempts) {
                    throw error
                }
                await new Promise(res => setTimeout(res, 250 * attempt))
            }
        }
    }
}
