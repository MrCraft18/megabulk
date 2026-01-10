import axios from "axios"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"

import File from '../File/index.js'
import b64urlToBuffer from "../../common/b64urlToBuffer.js"

export default class MegabulkProcess {
    constructor({ folderLink, downloadDirectory }) {
        this.folderLink = folderLink
        this.downloadDirectory = downloadDirectory

        this.folderHandle = folderLink.split('#')[0].split('/').at(-1)

        const folderKeyB64 = folderLink.split('#').at(-1)
        this.folderKey = b64urlToBuffer(folderKeyB64).toString('hex')

        this.maxConcurrentDownloads = 10
        this.maxConcurrentProxyChecking = 50

        this.proxyPools = {
            base: new Map(),
            working: new Map(),
            broken: new Map()
        }

        this.foundNewProxiesPromise = null
    }

    async start() {
        await this.findAndInsertProxies()
        setInterval(() => {
            if (!this.foundNewProxiesPromise) this.findAndInsertProxies()
        }, 60 * 60_000)

        this.allNodes = await axios.post('https://g.api.mega.co.nz/cs', [{ a: "f", c: 1, r: 1 }], {
            params: { id: Date.now(), n: this.folderHandle },
            headers: { "Content-Type": "application/json" },
        }).then(response => response.data[0].f)

        this.fileQueue = this.allNodes.filter(node => node.t === 0).map(node => new File(node, this))
        this.totalFiles = this.fileQueue.length
        this.totalBytes = this.fileQueue.reduce((sum, file) => sum + (file.size || 0), 0)

        if (!this.fileQueue.length) {
            console.log('No files in Folder to Download')
            return
        }

        console.clear()
        this.startRenderLoop()
        this.enqueueFileDownloads()

        const { promise, resolve, reject } = Promise.withResolvers()
        this.allFilesDownloaded = promise
        this.resolveAllFilesDownloaded = resolve

        return this.allFilesDownloaded
    }

    enqueueFileDownloads() {
        while (this.queueCount('finding proxy') < this.maxConcurrentProxyChecking && this.queueCount('downloading') < this.maxConcurrentDownloads) {
            const awaitingFile = this.fileQueue.find(file => file.status === 'waiting')
            awaitingFile.download()
        }
    }

    queueCount(status) {
        return status ? this.fileQueue.filter(file => file.status == status).length : this.fileQueue.length
    }

    async findAndInsertProxies() {
        let added = 0

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
                    attempts: 0,
                    lastUsed: 0,
                    cooldownUntil: 0
                })
                added++
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

        return added
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

            if (this.proxyPools.base.size > 0) {
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
            }

            return null
        })()

        if (proxy) {
            const now = Date.now()
            if (proxy.cooldownUntil && proxy.cooldownUntil > now) {
                await new Promise(res => setTimeout(res, proxy.cooldownUntil - now))
            }
            return proxy
        }

        if (!this.foundNewProxiesPromise) {
            this.startProxyRefreshLoop()
        }

        await this.foundNewProxiesPromise
        return await this.popProxy()
    }

    async startProxyRefreshLoop() {
        const { promise, resolve } = Promise.withResolvers()
        this.foundNewProxiesPromise = promise
        const resolveFoundNewProxies = resolve

        let added = await this.findAndInsertProxies()

        while (!added) {
            added = await this.findAndInsertProxies()
            await new Promise(res => setTimeout(res, 5 * 60_000))
        }

        resolveFoundNewProxies()
        this.foundNewProxiesPromise = null
    }

    hasProxy(address) {
        return this.proxyPools.base.has(address) || this.proxyPools.working.has(address) || this.proxyPools.broken.has(address)
    }

    reinsertProxy(proxy, pool = 'base') {
        if (!proxy) throw new Error('No proxy passed to reinsertProxy')

        if (pool === 'working') proxy.attempts = 0
        if (proxy.attempts >= 5) pool = 'broken'

        this.proxyPools.base.delete(proxy.address)
        this.proxyPools.working.delete(proxy.address)
        this.proxyPools.broken.delete(proxy.address)
        this.proxyPools[pool].set(proxy.address, proxy)
    }


    startRenderLoop() {
        if (this.renderInterval) return
        this.lastRenderLines = 0
        this.lastRenderRows = process.stdout.rows || 24
        this.renderStartTime = Date.now()
        this.bytesAtRenderStart = this.fileQueue.reduce((sum, file) => sum + (file.downloadedBytes || 0), 0)
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

        const activeFiles = this.fileQueue.filter(file => file.status === 'downloading')
        const lines = []

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

        const usableProxies = this.proxyPools.base.size + this.proxyPools.working.size
        const totalProxies = usableProxies + this.proxyPools.broken.size
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
