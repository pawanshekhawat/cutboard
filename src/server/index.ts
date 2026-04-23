#!/usr/bin/env node

import Fastify from 'fastify';
import { join, resolve } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import chokidar from 'chokidar';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';

const PROJECT_PATH = 'D:\\Coding\\Projects\\cutboard\\project.json';
const ASSETS_PATH = 'D:\\Coding\\Projects\\cutboard\\assets';

const server = Fastify({ logger: true });

// Store connected SSE clients
const sseClients = new Set<any>();

// Enable CORS for studio app
server.register(cors, {
  origin: ['http://localhost:5173', 'http://localhost:4173'],
  methods: ['GET', 'POST', 'PUT', 'DELETE']
});

// Serve assets
server.register(fastifyStatic, {
  root: ASSETS_PATH,
  prefix: '/assets/',
  prefixAvoidTrailingSlash: true
});

// Health check
server.get('/', async () => {
  return {
    status: 'ok',
    service: 'CutBoard API',
    version: '0.1.0',
    timestamp: new Date().toISOString()
  };
});

// SSE stream for real-time updates
server.get('/api/stream', (req, reply) => {
  reply.headers({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const client = reply.raw;
  sseClients.add(client);

  // Send initial connection event
  client.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  // Cleanup on client disconnect
  req.raw.on('close', () => {
    sseClients.delete(client);
    server.log.info('SSE client disconnected');
  });
});

// Broadcast update to all SSE clients
function broadcastUpdate() {
  const message = `data: ${JSON.stringify({ type: 'update', timestamp: Date.now() })}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (err) {
      // Client disconnected, will be cleaned up
      sseClients.delete(client);
    }
  });
}

// Get project
server.get('/api/project', async (request, reply) => {
  const query = request.query as any;
  const projectPath = query.path || PROJECT_PATH;
  
  try {
    const data = readFileSync(projectPath, 'utf-8');
    const project = JSON.parse(data);

    // Auto-normalize element transforms to match schema expectations.
    // (Prevents UI crashes when older projects only store partial transform objects.)
    let changed = false;
    if (project?.elements && typeof project.elements === 'object') {
      for (const el of Object.values(project.elements)) {
        if (!el || typeof el !== 'object') continue;
        const t = (el as any).transform;
        if (!t || typeof t !== 'object') {
          (el as any).transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
          changed = true;
          continue;
        }
        if (typeof t.x !== 'number') { t.x = 0; changed = true; }
        if (typeof t.y !== 'number') { t.y = 0; changed = true; }
        if (typeof t.scale !== 'number') { t.scale = 1; changed = true; }
        if (typeof t.rotation !== 'number') { t.rotation = 0; changed = true; }
        if (typeof t.opacity !== 'number') { t.opacity = 1; changed = true; }
      }
    }

    if (changed) {
      writeFileSync(projectPath, JSON.stringify(project, null, 2));
      // Broadcast so connected clients re-fetch a fully-normalized project.
      broadcastUpdate();
      server.log.info('Normalized project.json transforms');
    }

    return project;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Update element
server.post('/api/project/element', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, elementId, updates } = body;

  try {
    const data = readFileSync(projectPath, 'utf-8');
    const project = JSON.parse(data);

    if (!project.elements[elementId]) {
      return reply.status(404).send({ error: 'Element not found' });
    }

    project.elements[elementId] = {
      ...project.elements[elementId],
      ...updates
    };

    // Normalize transform on write too (keeps project.json schema-consistent)
    const t = project.elements[elementId]?.transform;
    if (!t || typeof t !== 'object') {
      project.elements[elementId].transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
    } else {
      if (typeof t.x !== 'number') t.x = 0;
      if (typeof t.y !== 'number') t.y = 0;
      if (typeof t.scale !== 'number') t.scale = 1;
      if (typeof t.rotation !== 'number') t.rotation = 0;
      if (typeof t.opacity !== 'number') t.opacity = 1;
    }

    writeFileSync(projectPath, JSON.stringify(project, null, 2));
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Updated element ${elementId}`);
    
    return project;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Update keyframe
server.post('/api/project/keyframe', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, elementId, property, keyframeIndex, value } = body;

  try {
    const data = readFileSync(projectPath, 'utf-8');
    const project = JSON.parse(data);

    // Find animations for this element and property
    const animationKey = Object.keys(project.animations || {}).find(key => {
      const anim = project.animations[key];
      return anim.target === elementId && anim.property === property;
    });

    if (!animationKey) {
      return reply.status(404).send({ error: 'Animation not found' });
    }

    const animation = project.animations[animationKey];
    if (!animation.keyframes[keyframeIndex]) {
      return reply.status(404).send({ error: 'Keyframe not found' });
    }

    animation.keyframes[keyframeIndex].value = value;

    writeFileSync(projectPath, JSON.stringify(project, null, 2));
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Updated keyframe ${keyframeIndex} for ${property} on element ${elementId}`);
    
    return project;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Add or update animation keyframe
server.post('/api/project/animation', async (request, reply) => {
  const body = request.body as any;
  const { projectPath = PROJECT_PATH, elementId, property, time, value, easing = 'linear' } = body;

  try {
    const data = readFileSync(projectPath, 'utf-8');
    const project = JSON.parse(data);

    if (!project.animations) {
      project.animations = {};
    }

    // Find existing animation for this element+property
    const animationKey = Object.keys(project.animations).find(key => {
      const anim = project.animations[key];
      return anim.target === elementId && anim.property === property;
    });

    if (animationKey) {
      // Add keyframe to existing animation
      const animation = project.animations[animationKey];
      animation.keyframes.push({ time, value, easing });
      // Sort keyframes by time
      animation.keyframes.sort((a: any, b: any) => a.time - b.time);
    } else {
      // Create new animation
      const animId = `anim_${Math.random().toString(36).substr(2, 6)}`;
      project.animations[animId] = {
        id: animId,
        target: elementId,
        property,
        keyframes: [{ time, value, easing }],
        easing
      };
    }

    writeFileSync(projectPath, JSON.stringify(project, null, 2));
    
    // Broadcast update to SSE clients
    broadcastUpdate();
    
    server.log.info(`Added keyframe at t=${time}s for ${property} on element ${elementId}`);
    
    return project;
  } catch (error: any) {
    reply.status(500).send({ error: error.message });
  }
});

// Start server
const start = async () => {
  try {
    await server.listen({ port: 3001 });
    console.log('🎬 CutBoard API Server running at http://localhost:3001');
    console.log('📺 Studio app should be at http://localhost:5173');
    
    // Watch project file and broadcast changes
    const watcher = chokidar.watch(PROJECT_PATH, {
      persistent: true,
      ignoreInitial: true
    });

    watcher.on('change', () => {
      server.log.info('project.json changed externally');
      broadcastUpdate();
    });
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
