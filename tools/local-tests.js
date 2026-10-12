/**
 * tools/local-tests.js — run the pure extraction logic under Node.
 *
 *   node tools/local-tests.js
 *
 * Runs the unit tests and pushes the synthetic fixtures through the real
 * engine. No Google services, no deployment.
 */
const engine = require('./load-engine').load();

const res = engine.runTests();
res.results.forEach(function (r) {
  console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass ? '' : '  -> ' + r.detail));
});
console.log('TESTS: ' + (res.total - res.failed) + '/' + res.total + ' passed');

console.log('\n===== FIXTURE PROBE (read-only) =====\n' + engine.probeFixtures());

process.exitCode = res.failed ? 1 : 0;
