import MegabulkProcess from "./classes/MegabulkProcess/index.js"

const [,, link, downloadDirectory] = process.argv

if (!link || !downloadDirectory) {
    console.error("Usage: node index.js <mega-folder-link> <download-path>")
    process.exit(1)
}

const main = new MegabulkProcess({ folderLink: link, downloadDirectory })

await main.start()
