import MegabulkProcess from "./classes/MegabulkProcess/index.js"

const main = new MegabulkProcess({ folderLink: link, downloadDirectory: path })

await main.start()
