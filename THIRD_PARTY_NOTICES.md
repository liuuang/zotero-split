# Third-Party Notices

Zotero Split is an independent Zotero plugin. Zotero is a separate project licensed primarily under AGPLv3; this project is not affiliated with or endorsed by Zotero.

The plugin uses Zotero's existing tab DOM and clones native tab icon and close-button elements at runtime so pane tabs follow the host application's style. It does not redistribute Zotero's source or artwork as repository assets.

Development and test dependencies include `zotero-plugin-scaffold` (AGPL-3.0-or-later), `zotero-types` (MIT), TypeScript (Apache-2.0), esbuild (MIT), Mocha (MIT), and Chai (MIT). Their license files are included with the installed packages; the exact dependency tree is recorded in `package-lock.json`.

When distributing a compiled XPI, retain any license or notice files required by components bundled into it. The project's AGPL license applies only to Zotero Split's own code and does not grant rights to third-party software.
