import axios from "axios"
import fs from "fs"
import path from "path";
import { pipeline } from "node:stream/promises"

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
        console.log(this.alreadyDownloaded(), path.join(this.process.downloadDirectory, this.directoryPath, `.downloaded.${this.name}`))
        if (this.alreadyDownloaded()) {
            this.status = "already downloaded"
            console.log(`Already downloaded ${this.name}`)

            if (this.process.fileQueue.length === 0) {
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

                console.log(response.data)
                console.log('Success!')
                this.downloadURL = response.data[0].g
            } catch (error) {
                console.log(`Proxy: ${this.proxy.address} Request Error: ${error}`)

                if (this.isTimeoutError(error)) {
                    this.proxy.attempts++
                    this.returnProxy()
                    console.log('Returned Proxy as Timeout')
                } else {
                    this.returnProxy('broken')
                    console.log('Returned Proxy as Broken For Sure')
                }

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

        console.log(`Downloading File: ${this.name} Concurrent Downloads: ${this.process.queueCount('downloading')}`)

        const streamPath = path.join(this.process.downloadDirectory, this.directoryPath, `${this.name}.part`)
        const startByte = fs.existsSync(streamPath) ? fs.statSync(streamPath).size : 0

        try {
            const stream = await axios.get(this.downloadURL, {
                responseType: "stream",
                headers: startByte ? { Range: `bytes=${startByte}-` } : {},
                httpAgent: this.proxy.agent,
                httpsAgent: this.proxy.agent,
                proxy: false,
                timeout: 20_000
            })

            let downloaded = 0

            stream.data.on("data", chunk => {
                downloaded += chunk.length
                console.log(`(${downloaded}/${this.size})`)
            })

            fs.mkdirSync(path.join(this.process.downloadDirectory, this.directoryPath), { recursive: true })

            await pipeline(stream.data, fs.createWriteStream(streamPath))
        } catch (error) {
            console.error(error)

            console.log(`Download Failed For: ${this.name} Concurrent Downloads: ${this.process.queueCount('downloading') - 1}`)

            if (error?.response?.status === 509) {
                console.log(`Download limit exceeded for : ${this.proxy.address}`)
                //Set some type of cooldown for the proxy here
                this.proxy.cooldownUntil = Date.now() + 5 * 60_000
                this.returnProxy()
            } else if (this.isTimeoutError(error)) {
                this.proxy.attempts++
                this.returnProxy()
            } else {
                this.returnProxy('broken')
            }

            delete this.downloadURL

            this.download()
            return
        }

        fs.renameSync(path.join(this.process.downloadDirectory, this.directoryPath, `${this.name}.part`), path.join(this.process.downloadDirectory, this.directoryPath, this.name))
        fs.writeFileSync(path.join(this.process.downloadDirectory, this.directoryPath, `.downloaded.${this.name}`), '')

        this.status = 'downloaded'
        console.log(`Finished Downloading File: ${this.name} Concurrent Downloads: ${this.process.queueCount('downloading')}`)
        console.log(`Files left to download: ${this.process.queueCount('waiting') + this.process.queueCount('finding proxy') + this.process.queueCount('downloading')}`)

        this.returnProxy('working')

        if (this.process.fileQueue.length === 0) {
            this.process.resolveAllFilesDownloaded()
        } else {
            this.process.enqueueFileDownloads()
        }
    }

    returnProxy(pool) {
        this.process.reinsertProxy(this.proxy, pool)
        delete this.proxy
    }

    alreadyDownloaded() {
        return fs.existsSync(path.join(this.process.downloadDirectory, this.directoryPath, `.downloaded.${this.name}`))
    }

    isTimeoutError(error) {
        const code = error?.code
        return code === "ETIMEDOUT" || code === "ECONNRESET" || code === "ECONNABORTED" || error?.name === "AbortError"
    }
}
