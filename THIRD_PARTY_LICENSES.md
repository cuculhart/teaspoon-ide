# Third-Party Licenses

Teaspoon IDE itself is distributed under the Functional Source License
(FSL-1.1-MIT) — see the `LICENSE` file. It is built on open-source
software. The licenses of the bundled
components are listed below. Full license texts are included in each
package's `node_modules/<package>/LICENSE` file (source builds) and in the
installed application's resources (packaged builds).

## Runtime dependencies

| Package | License | Copyright holder |
|---|---|---|
| Electron | MIT | OpenJS Foundation and Electron contributors |
| Monaco Editor (`monaco-editor`, `@monaco-editor/react`) | MIT | Microsoft Corporation |
| React / React DOM | MIT | Meta Platforms, Inc. and affiliates |
| xterm.js (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`) | MIT | The xterm.js authors |
| node-pty | MIT | Microsoft Corporation |
| marked | MIT | Marked contributors |
| DOMPurify | Apache-2.0 OR MPL-2.0 | Cure53 and contributors |
| simple-git | MIT | Steve King and contributors |
| electron-store | MIT | Sindre Sorhus |
| dotenv | BSD-2-Clause | Scott Motte and contributors |
| @google/generative-ai | Apache-2.0 | Google LLC |

## Build-time dependencies

Electron Forge, Vite, TypeScript, and related tooling are used at build
time only and are not distributed with the application.

## Notes

- MIT and BSD-2-Clause licenses require retaining the copyright notice and
  license text; they impose no other obligations on distribution.
- DOMPurify is dual-licensed (Apache-2.0 or MPL-2.0); Teaspoon IDE uses it under
  Apache-2.0.
- The full license text of each package can also be found on
  https://www.npmjs.com/ or in the package repository.
