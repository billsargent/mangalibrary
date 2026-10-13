# RAR sample archives

These four archives are the test files of the
[node-unrar-js](https://github.com/YuJianrong/node-unrar.js) project (`testFiles/`,
MIT licence), which is the library this server reads RAR archives with. They are here
because nothing on a development machine can write a compressed RAR: the format's
compressor belongs to its owner.

| File                | What it holds                                                  |
| ------------------- | -------------------------------------------------------------- |
| `FolderTest.rar`    | Two files in folders, one name with a space and one in Chinese |
| `WithComment.rar`   | Two empty files and an archive comment                         |
| `FileEncByName.rar` | Three files, two of them encrypted                             |
| `HeaderEnc1234.rar` | An archive whose headers are encrypted, so it cannot be listed |

They hold text, not images. A test that needs a comic's pages in a RAR builds one with
`writeRar` in `../../rar.ts`, which writes the uncompressed form of the format.
