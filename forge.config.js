module.exports = {
  packagerConfig: {
    // Extension-less on purpose: electron-packager picks .ico/.icns/.png per platform
    icon: 'assets/icon',
    // .node binaries cannot be loaded from inside an asar archive
    asar: {
      unpack: '**/node_modules/node-pty/**',
    },
    // The README/social-preview banner is repo-only; keep it out of the package
    ignore: [/teaspoon-banner\.png$/],
    // User-editable language files ship next to the app under resources/lang;
    // license texts ship alongside so bundled components' copyrights are preserved
    extraResource: ['lang', 'LICENSE', 'THIRD_PARTY_LICENSES.md'],
  },
  // node-pty ships N-API prebuilds that work in Electron as-is; a
  // node-gyp rebuild would need VS C++ build tools and is unnecessary.
  rebuildConfig: {
    onlyModules: [],
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        // Installer exe icon; iconUrl is shown in Add/Remove Programs and must
        // be a public https URL to an .ico (the committed file on GitHub)
        setupIcon: 'assets/icon.ico',
        iconUrl: 'https://raw.githubusercontent.com/cuculhart/teaspoon-ide/main/assets/icon.ico',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          // Packaged binary is named after productName ("Teaspoon"), not the
          // npm package name that maker-deb looks for by default
          bin: 'Teaspoon',
          icon: 'assets/icon.png',
          homepage: 'https://github.com/cuculhart/teaspoon-ide',
          section: 'devel',
          genericName: 'AI Coding Assistant',
          categories: ['Development', 'IDE'],
        },
      },
    },
  ],
  plugins: [],
}
