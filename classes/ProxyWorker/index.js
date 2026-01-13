import axios from "axios"

export default class ProxyWorker {
    constructor(process) {
        this.process = process
        this.status = 'offline'
    }

    async startChecking() {
        this.status = 'online'

        while (this.process.queueCount('downloading') < this.process.maxConcurrentDownloads) {
            const file = this.process.fileQueue.find(file => file.status === 'waiting')

            if (!file) break

            const proxy = await this.process.popProxy()

            try {
                const responseConfig = {
                    params: { id: Date.now(), n: this.process.folderHandle },
                    headers: { "Content-Type": "application/json" },
                    proxy: false,
                    signal: AbortSignal.timeout(10000)
                }

                if (proxy.agent) {
                    responseConfig.httpAgent = proxy.agent
                    responseConfig.httpsAgent = proxy.agent
                }

                const response = await axios.post('https://g.api.mega.co.nz/cs', [{ a: "g", g: 1, ssl: 0, n: file.id }], responseConfig)

                // console.log('Got A Download URL')

                const downloadURL = response.data[0].g

                if (file.status !== 'waiting' || (this.process.queueCount('downloading') + this.process.queueCount('requesting stream')) >= this.process.maxConcurrentDownloads) {
                    this.process.reinsertProxy(proxy, 'working')
                } else {
                    file.streamFile(downloadURL, proxy)
                }
            } catch (error) {
                // console.log(`Proxy Check Error: ${proxy.address} Request Error: ${error}`)
                // console.log(`Online Workers: ${this.process.proxyWorkers.filter(worker => worker.status === 'online').length} Currently Downloading: ${this.process.queueCount('downloading')} Waiting stream request: ${this.process.queueCount('requesting stream')}`)
                // if (error?.response?.status === 400) {
                //     console.log(error.response)
                // }
                // console.log(error?.response?.status)

                const now = Date.now()
                proxy.lastUsed = now
                proxy.cooldownUntil = now + 10 * 60_000
                this.process.reinsertProxy(proxy)
            }
        }

        this.status = 'offline'
    }
}
