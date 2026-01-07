import axios from "axios"

import decryptNodeAttributes from "./functions/decryptNodeAttributes.js";

export default class File {
    constructor(node, process) {
        this.process = process

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
    }

    async download() {
        this.status = 'finding proxy'

        while (!this.downloadURL) {
            if (this.process.fileQueue.filter(file => file.status === 'downloading').length >= 6) {
                console.log('I was checking proxies but 6 files already downloading')
                this.status = 'waiting'

                delete this.proxy
                delete this.downloadURL

                return
            }

            this.proxy = this.process.popProxy()

            if (!this.proxy) throw new Error('Ran out of proxies')

            try {
                const response = await axios.post('https://g.api.mega.co.nz/cs', [{ a: "g", g: 1, ssl: 0, n: this.id }], {
                    params: { id: Date.now(), n: this.process.folderHandle },
                    headers: { "Content-Type": "application/json" },
                    httpAgent: this.proxy.agent,
                    httpsAgent: this.proxy.agent,
                    proxy: false,
                    signal: AbortSignal.timeout(5000)
                })

                console.log(response.data)
                console.log('Success!')
                this.downloadURL = response.data[0].g
            } catch (error) {
                console.log(`Proxy: ${this.proxy.address} Request Error: ${error}`)

                this.proxy.status = 'broken'
                this.process.insertProxy(this.proxy)
            }
        }

        if (this.process.fileQueue.filter(file => file.status === 'downloading').length >= 6) {
            console.log('I found a good proxy but 6 files already downloading')
            this.status = 'waiting'

            this.proxy.status = 'working'
            this.process.insertProxy(this.proxy)
            
            delete this.proxy
            delete this.downloadURL

            return
        }

        this.status = 'downloading'
        this.process.enqueueFileDownloads()

        console.log(`Downloading File: ${this.name} Concurrent Downloads: ${this.process.fileQueue.filter(file => file.status === 'downloading').length}`)
        await new Promise(res => setTimeout(res, 60000))

        this.process.removeFileFromQueue(this)
        console.log(`Finished Downloading File: ${this.name} Concurrent Downloads: ${this.process.fileQueue.filter(file => file.status === 'downloading').length}`)
        console.log(`Files left to download: ${this.process.fileQueue.length}`)

        this.proxy.status = 'working'
        this.process.insertProxy(this.proxy)

        if (this.process.fileQueue.length === 0) {
            this.process.resolveAllFilesDownloaded()
        } else {
            this.process.enqueueFileDownloads()
        }
    }
}
