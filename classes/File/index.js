import axios from "axios"
import fs from "fs"
import path from "path";
import { pipeline } from "node:stream/promises"
import crypto from "node:crypto"
import decryptNodeAttributes from "./functions/decryptNodeAttributes.js";
import { aes128EcbDecrypt, xor32hex, b64urlToBuffer } from "../../common/megaCrypto.js"

const PROXY_COOLDOWN_MS = 10 * 60_000

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
        this.startedAt = null
        this.lastTickTime = 0
        this.speed = 0
        this.eta = 0
        this.speedSamples = []
    }

    async download() {
        if (this.alreadyDownloaded()) {
            this.downloadedBytes = this.size
            this.status = "already downloaded"

            if (this.process.pendingFileCount() === 0) {
                this.process.resolveAllFilesDownloaded()
            } else {
                this.process.enqueueFileDownloads()
            }

            return
        }

        this.status = 'finding proxy'

        while (!this.downloadURL) {
            if (this.process.queueCount('downloading') >= this.process.maxConcurrentDownloads) {
                this.status = 'waiting'

                delete this.downloadURL

                return
            }

            this.proxy = await this.process.popProxy()

            if (!this.proxy) throw new Error('Ran out of proxies')

            try {
                const response = await axios.post('https://g.api.mega.co.nz/cs', [{ a: "g", g: 1, ssl: 0, n: this.id }], {
                    params: { id: Date.now(), n: this.process.folderHandle },
                    headers: { "Content-Type": "application/json" },
                    httpAgent: this.proxy.agent,
                    httpsAgent: this.proxy.agent,
                    proxy: false,
                    signal: AbortSignal.timeout(10000)
                })

                this.downloadURL = response.data[0].g
            } catch (error) {
                this.applyProxyCooldown()
                this.returnProxy()
            }
        }

        if (this.process.queueCount('downloading') >= this.process.maxConcurrentDownloads) {
            this.status = 'waiting'

            this.returnProxy('working')
            
            delete this.downloadURL

            return
        }

        this.streamFile()
    }

    async streamFile() {
        this.status = 'downloading'
        this.process.enqueueFileDownloads()

        const streamPath = path.join(this.process.downloadDirectory, this.directoryPath, `${this.name}.part`)
        const startByte = fs.existsSync(streamPath) ? fs.statSync(streamPath).size : 0
        this.startByte = startByte
        this.downloadedBytes = startByte
        this.startedAt = Date.now()
        this.lastTickTime = this.startedAt
        this.speedSamples = [{ time: this.startedAt, bytes: this.downloadedBytes }]

        try {
            const controller = new AbortController()
            function resetTimeout() {
                clearTimeout(controller.timeoutId)
                controller.timeoutId = setTimeout(() => {
                    const err = new Error("Stream timeout")
                    err.code = "ETIMEDOUT"
                    controller.abort(err)
                }, 10_000)
            }
            resetTimeout()

            const stream = await axios.get(this.downloadURL, {
                responseType: "stream",
                headers: startByte ? { Range: `bytes=${startByte}-` } : {},
                httpAgent: this.proxy.agent,
                httpsAgent: this.proxy.agent,
                proxy: false,
                signal: controller.signal
            })

            const streamError = new Promise((_, reject) => {
                // stream.data.once("error", reject)
                stream.data.once("error", error => {
                    reject(error)
                })
            })

            stream.data.on("data", chunk => {
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
            })

            fs.mkdirSync(path.join(this.process.downloadDirectory, this.directoryPath), { recursive: true })

            const writeStream = fs.createWriteStream(streamPath, {
                flags: startByte > 0 ? "a" : "w"
            })

            await Promise.race([
                pipeline(stream.data, writeStream),
                streamError
            ])
            clearTimeout(controller.timeoutId)
        } catch (error) {
            if (error?.code === "ERR_CANCELED" && error?.cause?.code === "ETIMEDOUT") {
                error = error.cause
            }

            this.applyProxyCooldown()
            this.returnProxy()

            delete this.downloadURL

            this.download()
            return
        }


        const finalPath = path.join(this.process.downloadDirectory, this.directoryPath, this.name)
        await this.decryptFileContent(streamPath, finalPath)
        fs.unlinkSync(streamPath)
        fs.writeFileSync(path.join(this.process.downloadDirectory, this.directoryPath, `.downloaded.${this.name}`), '')

        this.downloadedBytes = this.size
        this.status = 'downloaded'
        this.returnProxy('working')

        if (this.process.pendingFileCount() === 0) {
            this.process.resolveAllFilesDownloaded()
        } else {
            this.process.enqueueFileDownloads()
        }
    }

    applyProxyCooldown() {
        const now = Date.now()
        this.proxy.lastUsed = now
        this.proxy.cooldownUntil = now + PROXY_COOLDOWN_MS
    }

    returnProxy(pool) {
        this.process.reinsertProxy(this.proxy, pool)
        delete this.proxy
    }

    alreadyDownloaded() {
        return fs.existsSync(path.join(this.process.downloadDirectory, this.directoryPath, `.downloaded.${this.name}`))
    }

    async decryptFileContent(inputPath, outputPath) {
        const nodeKeyB64 = this.node.k.split(":").at(-1)
        const nodeKeyBytes = b64urlToBuffer(nodeKeyB64)
        const nodeKeyHex = aes128EcbDecrypt(this.process.folderKey, nodeKeyBytes).toString("hex")

        if (nodeKeyHex.length < 64) {
            throw new Error("Invalid node key length for file content")
        }

        const w = []
        for (let i = 0; i < 8; i++) w.push(nodeKeyHex.slice(i * 8, i * 8 + 8))

        const fileKeyHex = xor32hex(w[0], w[4]) + xor32hex(w[1], w[5]) + xor32hex(w[2], w[6]) + xor32hex(w[3], w[7])
        const ivHex = w[4] + w[5] + "00000000" + "00000000"

        const key = Buffer.from(fileKeyHex, "hex")
        const iv = Buffer.from(ivHex, "hex")

        const maxAttempts = 3
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const decipher = crypto.createDecipheriv("aes-128-ctr", key, iv)
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
