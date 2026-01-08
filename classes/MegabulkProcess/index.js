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

        this.maxConcurrentDownloads = 1
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

        if (!this.fileQueue.length) {
            console.log('No files in Folder to Download')
            return
        }

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
}
