Run the DM app regression tests with Node.js; no packages or network access are needed:

```sh
node --test tests/*.test.mjs
```

The harness reads `web/dm/index.html` and executes the production script in a VM. A small DOM supports the actual navigation, question grading, and tracker event handlers. Tests can evaluate expressions within the app's closure using an evaluator injected into the VM copy. The shipped app needs no testing hooks.

The harness does not render canvas or test browser layout, touch gestures, service workers, or server synchronization. Those need browser or integration checks.

To check that a regression test detects a previous version, point it at another copy of the app:

```sh
DM_APP_HTML=/absolute/path/to/previous-index.html node --test tests/*.test.mjs
```

Random generator checks use a reproducible seed, with explicit random inputs for boundary cases.
