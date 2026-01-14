import axios from "axios"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"

import File from '../File/index.js'
import ProxyWorker from "../ProxyWorker/index.js"
import { b64urlToBuffer } from "../../common/megaCrypto.js"

export default class MegabulkProcess {
    constructor({ folderLink, downloadDirectory }) {
        this.folderLink = folderLink
        this.downloadDirectory = downloadDirectory

        this.folderHandle = folderLink.split('#')[0].split('/').at(-1)

        const folderKeyB64 = folderLink.split('#').at(-1)
        this.folderKey = b64urlToBuffer(folderKeyB64).toString('hex')

        this.maxConcurrentDownloads = 20
        this.proxyWorkerAmount = 100

        this.flatten = true

        this.proxyPools = {
            base: new Map(),
            working: new Map()
        }

        this.proxyPools.working.set('direct://', {
            address: 'direct://',
            agent: null,
            lastUsed: 0,
            cooldownUntil: 0
        })

        this.proxyWorkers = Array.from({ length: this.proxyWorkerAmount }, () => new ProxyWorker(this))

        this.foundNewProxiesPromise = null
        this.proxyRefreshInterval = null
        this.finished = false
        this.verificationJobs = new Set()
        this.verifyScriptPath = fileURLToPath(new URL("../../index.js", import.meta.url))
    }

    async start() {
        const { promise, resolve, reject } = Promise.withResolvers()
        this.allFilesDownloaded = promise
        this.resolveAllFilesDownloaded = resolve
        
        this.allNodes = await axios.post('https://g.api.mega.co.nz/cs', [{ a: "f", c: 1, r: 1 }], {
            params: { id: Date.now(), n: this.folderHandle },
            headers: { "Content-Type": "application/json" },
        }).then(response => response.data[0].f)

        this.fileQueue = this.allNodes.filter(node => node.t === 0).map(node => {
            const file = new File(node, this)

            if (file.alreadyDownloaded()) {
                file.downloadedBytes = file.size
                file.status = "already downloaded"
                return file
            }

            if (file.hasVerificationMarker()) {
                if (file.fileExists()) {
                    file.downloadedBytes = file.size
                    file.verifyProgress = 0
                    file.status = "verifying"
                    this.queueVerification(file, file.getFileCryptoParams(), file.getFinalPath())
                } else {
                    file.clearVerificationMarker()
                }
            }

            return file
        })

        if (this.fileQueue.every(file => file.status === 'already downloaded')) {
            this.finishAllDownloads()
            return
        }

        this.totalFiles = this.fileQueue.length
        this.totalBytes = this.fileQueue.reduce((sum, file) => sum + (file.size || 0), 0)

        // for (const file of this.fileQueue) {
        //     if (file.status === "waiting") console.log(file.directoryPath, file.name, file.node)
        // }

        if (!this.fileQueue.length) {
            console.log('No files in Folder to Download')
            return
        }

        await this.findAndInsertProxies()
        this.proxyRefreshInterval = setInterval(() => {
            if (!this.foundNewProxiesPromise) this.findAndInsertProxies()
        }, 60 * 60_000)

        console.clear()
        this.startRenderLoop()
        this.ensureProxyWorkers()

        return this.allFilesDownloaded
    }

    finishAllDownloads() {
        if (this.finished) return
        this.finished = true
        this.stopRenderLoop()
        if (this.proxyRefreshInterval) {
            clearInterval(this.proxyRefreshInterval)
            this.proxyRefreshInterval = null
        }
        console.log('All Files Downloaded')
        this.resolveAllFilesDownloaded()
        process.exit(0)
    }

    ensureProxyWorkers() {
        for (const proxyWorker of this.proxyWorkers) {
            if (proxyWorker.status === 'offline') proxyWorker.startChecking()
        }
    }

    queueCount(status) {
        return status ? this.fileQueue.filter(file => file.status == status).length : this.fileQueue.length
    }

    pendingFileCount() {
        const pendingStatuses = new Set(["waiting", "requesting stream", "downloading", "verifying"])
        return this.fileQueue.filter(file => pendingStatuses.has(file.status)).length
    }

    queueVerification(file, cryptoParams, filePath) {
        const args = [
            this.verifyScriptPath,
            "--verify",
            filePath,
            cryptoParams.key.toString("hex"),
            cryptoParams.nonce.toString("hex"),
            cryptoParams.metaMac.toString("hex")
        ]

        const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "ignore", "ipc"] })

        child.on("message", message => {
            if (message?.type === "verify-progress" && typeof message.processed === "number") {
                file.verifyProgress = Math.min(message.processed, file.size || message.processed)
            }
        })

        const job = new Promise(resolve => {
            child.on("exit", code => resolve(code === 0))
            child.on("error", () => resolve(false))
        })

        this.verificationJobs.add(job)

        job.then(ok => {
            if (ok) {
                file.markVerified()
            } else {
                file.handleVerificationFailure()
            }
        }).finally(() => {
            this.verificationJobs.delete(job)
            this.checkForCompletion()
        })

        return job
    }

    checkForCompletion() {
        if (this.pendingFileCount() === 0 && this.verificationJobs.size === 0) {
            this.finishAllDownloads()
        }
    }

    async findAndInsertProxies() {
        const fetchedProxies =  [
            ...(await axios.get('https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/all/data.txt').then(response => response.data)).split('\n'),
            ...(await axios.get('https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt').then(response => response.data)).split('\n').map(address => 'socks5://' + address),
            ...(await axios.get('https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt').then(response => response.data)).split('\n').map(address => 'socks4://' + address),
            ...(await axios.get('https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt').then(response => response.data)).split('\n').map(address => 'http://' + address),
        ]

        for (const proxy of fetchedProxies.map(value => value.trim()).filter(Boolean)) {
            if (!this.hasProxy(proxy)) {
                this.proxyPools.base.set(proxy, {
                    address: proxy,
                    agent: makeAgent(proxy),
                    lastUsed: 0,
                    cooldownUntil: 0
                })
            }
        }

        function makeAgent(proxy) {
            const proxyURL = new URL(proxy)

            const protocol = proxyURL.protocol.replace(':', '').toLowerCase()

            if (protocol === "http" || protocol === "https") {
                return new HttpsProxyAgent(proxyURL)
            }

            if (protocol.startsWith("socks")) {
                return new SocksProxyAgent(proxyURL)
            }

            throw new Error(`Unknown proxy URL: ${proxyURL}`)
        }
    }

    async popProxy() {
        const proxy = (() => {
            if (this.proxyPools.working.size > 0) {
                const target = Math.floor(Math.random() * this.proxyPools.working.size)
                let i = 0
                for (const [k, v] of this.proxyPools.working) {
                    if (i === target) {
                        this.proxyPools.working.delete(k)
                        v.lastUsed = Date.now()
                        return v
                    }
                    i++
                }
            }

            let oldestKey = null
            let oldestProxy = null

            for (const [k, v] of this.proxyPools.base) {
                if (!oldestProxy || v.lastUsed < oldestProxy.lastUsed) {
                    oldestKey = k
                    oldestProxy = v
                }
            }

            if (oldestKey) {
                this.proxyPools.base.delete(oldestKey)
                oldestProxy.lastUsed = Date.now()
                return oldestProxy
            }
        })()

        const now = Date.now()
        if (proxy.cooldownUntil && proxy.cooldownUntil > now) {
            await new Promise(res => setTimeout(res, proxy.cooldownUntil - now))
        }
        return proxy
    }

    hasProxy(address) {
        return this.proxyPools.base.has(address) || this.proxyPools.working.has(address)
    }

    reinsertProxy(proxy, pool = 'base') {
        if (!proxy) throw new Error('No proxy passed to reinsertProxy')

        this.proxyPools.base.delete(proxy.address)
        this.proxyPools.working.delete(proxy.address)
        this.proxyPools[pool].set(proxy.address, proxy)
    }

    startRenderLoop() {
        if (this.renderInterval) return
        this.lastRenderLines = 0
        this.lastRenderRows = process.stdout.rows || 24
        this.renderStartTime = Date.now()
        process.stdout.write("\x1b[?25l")
        this.configureScrollRegion()
        this.renderInterval = setInterval(() => this.render(), 200)
    }

    stopRenderLoop() {
        if (!this.renderInterval) return
        clearInterval(this.renderInterval)
        this.renderInterval = null
        process.stdout.write("\x1b[r")
        process.stdout.write("\x1b[?25h")
    }

    configureScrollRegion() {
        const rows = process.stdout.rows || 24
        this.renderRegionSize = Math.max(this.maxConcurrentDownloads + 2, 2)
        const bottom = Math.max(rows - this.renderRegionSize, 1)
        process.stdout.write(`\x1b[1;${bottom}r`)
    }

    render() {
        const ESC = "\x1b["
        const clearLine = () => process.stdout.write(ESC + "2K")
        const moveTo = (row, col) => process.stdout.write(`${ESC}${row};${col}H`)
        const saveCursor = () => process.stdout.write(ESC + "s")
        const restoreCursor = () => process.stdout.write(ESC + "u")
        const columns = process.stdout.columns || 80
        const rows = process.stdout.rows || 24

        if (rows !== this.lastRenderRows) {
            this.lastRenderRows = rows
            this.configureScrollRegion()
        }

        const verifyingFiles = this.fileQueue.filter(file => file.status === 'verifying')
        const activeFiles = this.fileQueue.filter(file => file.status === 'downloading')
        const lines = []

        for (const file of verifyingFiles) {
            lines.push([
                `VERIFYING ${file.name}`,
                this.formatBytes(file.size, { fixedDecimals: 2 }),
                `${this.formatPercent(file.verifyProgress || 0, file.size)}`
            ].join(" | "))
        }

        if (verifyingFiles.length > 0 && activeFiles.length > 0) {
            lines.push("-".repeat(Math.max(columns - 1, 0)))
        }

        for (const file of activeFiles) {
            lines.push([
                file.name,
                this.formatBytes(file.size, { fixedDecimals: 2 }),
                `${this.formatPercent(file.downloadedBytes, file.size)}`,
                this.formatSpeed(file.speed),
                this.formatEta(file.eta)
            ].join(" | "))
        }

        if (lines.length > 0) {
            lines.push("-".repeat(Math.max(columns - 1, 0)))
        }

        const now = Date.now()
        const readyBase = [...this.proxyPools.base.values()].filter(proxy => !proxy.cooldownUntil || proxy.cooldownUntil <= now).length
        const readyWorking = [...this.proxyPools.working.values()].filter(proxy => !proxy.cooldownUntil || proxy.cooldownUntil <= now).length
        const usableProxies = readyBase + readyWorking
        const totalProxies = this.proxyPools.base.size + this.proxyPools.working.size
        const downloadedFiles = this.fileQueue.filter(file => file.status === 'downloaded' || file.status === 'already downloaded').length
        const bytesSoFar = this.fileQueue.reduce((sum, file) => sum + (file.downloadedBytes || 0), 0)
        const activeCount = activeFiles.length
        const combinedSpeed = activeFiles.reduce((sum, file) => sum + (file.speed || 0), 0)
        const remainingBytes = Math.max(this.totalBytes - bytesSoFar, 0)
        const elapsed = this.renderStartTime ? (Date.now() - this.renderStartTime) / 1000 : 0
        const bytesDelta = this.fileQueue.reduce((sum, file) => {
            if (!file.startedAt) return sum
            const startByte = file.startByte || 0
            const delta = Math.max((file.downloadedBytes || 0) - startByte, 0)
            return sum + delta
        }, 0)
        const avgSpeed = elapsed > 0 ? bytesDelta / elapsed : 0
        const totalEta = avgSpeed > 0 ? remainingBytes / avgSpeed : 0

        lines.push([
            `${usableProxies}/${totalProxies} proxies`,
            `${downloadedFiles}/${this.totalFiles} files`,
            `${this.formatBytes(bytesSoFar, { fixedDecimals: 2 })}/${this.formatBytes(this.totalBytes, { fixedDecimals: 2 })}`,
            `${activeCount} downloading`,
            this.formatSpeed(combinedSpeed),
            this.formatEta(totalEta)
        ].join(" | "))

        const regionSize = this.renderRegionSize || Math.max(this.maxConcurrentDownloads + 2, 2)
        const regionStart = Math.max(1, rows - regionSize + 1)
        const startRow = Math.max(regionStart, rows - lines.length + 1)

        saveCursor()
        for (let i = 0; i < regionSize; i++) {
            const row = regionStart + i
            moveTo(row, 1)
            clearLine()
        }
        for (let i = 0; i < lines.length; i++) {
            const row = startRow + i
            moveTo(row, 1)
            const line = lines[i].slice(0, Math.max(columns - 1, 0))
            process.stdout.write(line)
        }
        restoreCursor()

        this.lastRenderLines = lines.length
    }

    formatBytes(bytes, options = {}) {
        if (!bytes || bytes <= 0) return "0 B"
        const units = ["B", "KB", "MB", "GB", "TB"]
        let value = bytes
        let unit = 0
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024
            unit++
        }
        if (options.fixedDecimals !== undefined) {
            return `${value.toFixed(options.fixedDecimals)} ${units[unit]}`
        }
        const gbDecimals = options.gbDecimals ?? 1
        const decimals = unit >= 3 ? gbDecimals : (value >= 10 || unit === 0 ? 0 : 1)
        return `${value.toFixed(decimals)} ${units[unit]}`
    }

    formatSpeed(bytesPerSecond) {
        return `${this.formatBytes(bytesPerSecond)}/s`
    }

    formatPercent(done, total) {
        if (!total) return "0%"
        const pct = Math.min(Math.max(done / total, 0), 1) * 100
        return `${pct.toFixed(1)}%`
    }

    formatEta(seconds) {
        if (!seconds || seconds <= 0) return "--:--"
        const mins = Math.floor(seconds / 60)
        const secs = Math.floor(seconds % 60)
        const hours = Math.floor(mins / 60)
        const remMins = mins % 60
        if (hours > 0) {
            return `${hours}:${String(remMins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
        }
        return `${remMins}:${String(secs).padStart(2, "0")}`
    }
}
