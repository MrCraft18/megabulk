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
    }

    async start() {
        await this.startProxyManager()

        this.allNodes = await axios.post('https://g.api.mega.co.nz/cs', [{ a: "f", c: 1, r: 1 }], {
            params: { id: Date.now(), n: this.folderHandle },
            headers: { "Content-Type": "application/json" },
        }).then(response => response.data[0].f)

        this.fileQueue = this.allNodes.filter(node => node.t === 0).map(node => new File(node, this))

        this.enqueueFileDownloads()

        const { promise, resolve, reject } = Promise.withResolvers()
        this.allFilesDownloaded = promise
        this.resolveAllFilesDownloaded = resolve

        return this.allFilesDownloaded
    }

    enqueueFileDownloads() {
        while (this.fileQueue.filter(file => file.status === 'finding proxy').length < 50 && this.fileQueue.filter(file => file.status === 'downloading').length < 6) {
            const awaitingFile = this.fileQueue.find(file => file.status === 'waiting')
            awaitingFile.download()
        }
    }

    removeFileFromQueue(fileToRemove) {
        const idx = this.fileQueue.findIndex(file => file.id === fileToRemove.id)
        if (idx === -1) return false
        this.fileQueue.splice(idx, 1)
        return true
    }

    async startProxyManager() {
        this.proxies = new Map()

        await this.findAndInsertProxies()
        setInterval(() => this.findAndInsertProxies(), 60_000 * 60)
    }

    async findAndInsertProxies() {
        const fetchedProxies =  [
            ...(await axios.get('https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/all/data.txt').then(response => response.data)).split('\n'),
            ...(await axios.get('https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks5.txt').then(response => response.data)).split('\n').map(address => 'socks5://' + address),
            ...(await axios.get('https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/socks4.txt').then(response => response.data)).split('\n').map(address => 'socks4://' + address),
            ...(await axios.get('https://raw.githubusercontent.com/TheSpeedX/SOCKS-List/master/http.txt').then(response => response.data)).split('\n').map(address => 'http://' + address),
        ]

        for (const proxy of fetchedProxies) {
            if (!this.proxies.get(proxy)) {

                this.proxies.set(proxy, { address: proxy, status: 'unchecked', agent: makeAgent(proxy) })
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

    popProxy() {
        if (this.proxies.size === 0) return null

        const working = []
        const unchecked = []

        for (const [k, v] of this.proxies) {
            if (v.status === "working") working.push([k, v])
            else if (v.status === "unchecked") unchecked.push([k, v])
        }

        const candidates = working.length > 0 ? working : unchecked
        if (candidates.length === 0) return null

        const target = Math.floor(Math.random() * candidates.length)
        const [k, v] = candidates[target]
        this.proxies.delete(k)
        return v
    }

    insertProxy(proxy) {
        this.proxies.set(proxy.address, proxy)
    }
}
