Run the app regression tests with Node.js; no packages or network access are needed:

```sh
node --test tests/*.test.mjs
go test ./...
```

The browser-app harnesses execute the production scripts in a VM with a small DOM and controlled clocks. Tests exercise actual keypad grading, navigation, pause timers, forms, hints, language changes, resets, and background save acknowledgements. The shipped apps need no testing hooks. Signal content tests independently decode the ciphers and check the translated math and time answers.

DM variety tests check the generated math as well as outcome coverage. Encounters cover every supported level, party size, and rank, including the first budget calculation and the final difficulty rating. Budget questions cover all three calculations before repeating and avoid consecutive duplicates, even with repeated random draws and during review. Other checks cover dice-comparison results, Finesse choices, actions, spell-slot boundaries, thrown weapons, critical damage, and chest calculations. Seeded practice sequences check shuffled coverage and repeat limits, including review, daily quests, and boss fights. Review tests use the grading controls to verify that clearing a missed type requires two complete examples without hints.

Shared-sync tests use separate device stores and a conditional-write server model to cover concurrent progress, screen-time credits and debits, lost acknowledgements, durable retries, reset generations, and legacy imports. Go tests cover the real SQLite compare-and-swap transactions and HTTP protocol, including simultaneous writers through independent database connections.

The harnesses do not render canvas or test browser layout, touch gestures, service-worker installation, or real network connectivity. Verify those with a local server and disposable save codes before deployment.

To compare a regression against an older app, set `DM_APP_HTML`, `CHAIN_APP_HTML`, or `SIGNAL_APP_HTML` to its absolute path. Shared scripts and story files continue to load from this checkout. Random generator tests use reproducible seeds, with explicit inputs for boundary cases.

For a real HTTP concurrency check against a disposable server:

```sh
KIDAPPS_BASE_URL=http://127.0.0.1:8765 node tests/http-sync-integration.mjs
```

This creates one new save code for each app and checks concurrent credits, cash-in conflicts, puzzle progress, and language progress through the real API. It never reads or changes an existing family's save.
