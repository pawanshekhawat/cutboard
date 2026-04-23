#!/usr/bin/env node

import { mkdirSync, existsSync } from 'fs';
import { Command } from 'commander';
import { initProject, loadProject } from '../engine/project.js';
import { render } from '../engine/render.js';
import { runScript, evalScript } from '../script-engine/index.js';
import { startWatcher } from '../watcher/index.js';

const program = new Command();

program
  .name('cutboard')
  .description('Agent-first programmable video engine')
  .version('0.1.0');

program
  .command('init')
  .argument('<name>', 'project name')
  .option('-o, --root <path>', 'project root', '.')
  .action((name, opts) => {
    if (opts.root !== '.' && !existsSync(opts.root)) mkdirSync(opts.root, { recursive: true });
    initProject(name, opts.root);
  });

program
  .command('dev')
  .option('-o, --root <path>', 'project root', '.')
  .action((opts) => {
    const project = loadProject(opts.root);
    console.log(`[dev] Watching ${opts.root} — ${Object.keys(project.elements).length} element(s)`);
    startWatcher(opts.root, (p) => {
      console.log(`[dev] project.json changed — ${Object.keys(p.elements).length} element(s)`);
    });
    process.stdin.resume();
  });

program
  .command('render')
  .option('-o, --root <path>', 'project root', '.')
  .option('-O, --output <path>', 'output path', './output/render.mp4')
  .action((opts) => {
    const project = loadProject(opts.root);
    render(project, opts.output, opts.root);
  });

program
  .command('exec')
  .argument('<script>', 'path to script file')
  .option('-o, --root <path>', 'project root', '.')
  .action((script, opts) => {
    runScript(script, opts.root).catch(e => { console.error(e); process.exit(1); });
  });

program
  .command('eval')
  .argument('<expr>', 'one-liner expression')
  .option('-o, --root <path>', 'project root', '.')
  .action((expr, opts) => {
    evalScript(expr, opts.root).catch(e => { console.error(e); process.exit(1); });
  });

program.parse();