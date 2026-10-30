#!/usr/bin/env node
/*
 * CS2 Demo Fixer - command line.
 * Usage: node cli.js <demo.dem | demo.dem.zst | demo.dem.gz> [output.dem]
 *
 * Uses only Node.js built-in modules. No network, no third-party packages.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const DemoFix = require('./demofix.js');

function usage() {
  console.error('Usage: node cli.js <demo.dem | demo.dem.zst | demo.dem.gz> [output.dem]');
}

const args = process.argv.slice(2);
if (args.length === 0) {
  usage();
  process.exit(2);
}

const input = args[0];
const outputArg = args[1];

let data;
try {
  data = new Uint8Array(fs.readFileSync(input));
} catch (e) {
  console.error('Cannot read input: ' + e.message);
  process.exit(1);
}

const format = DemoFix.detectFormat(data);
try {
  if (format === 'zst') {
    data = new Uint8Array(zlib.zstdDecompressSync(data));
  } else if (format === 'gz') {
    data = new Uint8Array(zlib.gunzipSync(data));
  } else if (format === 'bz2') {
    console.error('Bzip2 is not supported. Extract it first, then run this tool on the .dem file.');
    process.exit(1);
  } else if (format === 'csgo') {
    console.error('This is a CS:GO demo, not a CS2 demo.');
    process.exit(1);
  } else if (format !== 'dem') {
    console.error('Not a CS2 demo: ' + input);
    process.exit(1);
  }
} catch (e) {
  console.error('Cannot unpack input: ' + e.message);
  process.exit(1);
}

let result;
try {
  result = DemoFix.fixDemo(data);
} catch (e) {
  console.error('Repair failed: ' + (e.code ? e.code + ': ' : '') + e.message);
  process.exit(1);
}

const r = result.report;
if (r.header.map) console.log('Map: %s, protocol %s', r.header.map, r.header.protocol);

if (!result.changed) {
  console.log('No known problem found - nothing to fix.');
  process.exit(0);
}

if (r.crashFix.applied) {
  r.crashFix.tables.forEach((t) => {
    t.added.forEach((a) => {
      console.log('Crash fix: moved %s baseline (%s[%d]) from tick %d into the signon table',
        a.className || a.key, t.name, a.index, r.crashFix.firstPacketTick);
    });
    if (t.duplicatesRemoved) {
      console.log('Crash fix: removed %d duplicate %s update(s)', t.duplicatesRemoved, t.name);
    }
  });
  if (r.crashFix.fullPacketTrimmed.length) {
    console.log('Crash fix: cleaned %s from the full-packet snapshot', r.crashFix.fullPacketTrimmed.join(', '));
  }
}
r.textFix.items.forEach((i) => {
  console.log('Text fix: tick %d %s.%s [%s] -> %j', i.tick, i.event, i.key, i.before, i.after);
});
r.warnings.forEach((w) => console.log('Warning: ' + w));

const base = path.basename(input)
  .replace(/\.(zst|gz)$/i, '')
  .replace(/[._]dem$/i, '');
const output = outputArg || path.join(path.dirname(input), base + '-fixed.dem');

if (path.resolve(output) === path.resolve(input)) {
  console.error('Refusing to overwrite the original demo. Choose another output path.');
  process.exit(1);
}

try {
  const fd = fs.openSync(output, 'w');
  try {
    for (const part of result.parts) fs.writeSync(fd, part);
  } finally {
    fs.closeSync(fd);
  }
} catch (e) {
  console.error('Cannot write output: ' + e.message);
  process.exit(1);
}

console.log('Wrote %s (%d bytes)', output, result.size);
