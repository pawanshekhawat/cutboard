import axios from 'axios';
import { normalizeProjectContract } from '../../../src/shared/project-contract.ts';
import { buildApiUrl, withProjectPath } from './config';

export interface ProjectData {
  version: string;
  meta: {
    name: string;
    fps: number;
    resolution: { width: number; height: number };
    duration: number;
  };
  assets: Record<string, {
    id?: string;
    type: 'video' | 'image' | 'audio' | 'composition';
    src: string;
    duration?: number;
    resolution?: { width: number; height: number };
  }>;
  elements: Record<string, {
    id: string;
    type: 'video' | 'image' | 'text' | 'audio' | 'composition';
    assetId?: string;
    content?: string;
    style?: {
      fontSize?: number;
      color?: string;
      fontFamily?: string;
    };
    start: number;
    duration: number;
    trimStart?: number;
    trimDuration?: number;
    volume?: number;
    transform: {
      x: number;
      y: number;
      scale: number;
      rotation: number;
      opacity: number;
    };
  }>;
  tracks: Array<{
    id: string;
    type: 'video' | 'audio';
    elements: string[];
  }>;
  animations?: Record<string, {
    id: string;
    target: string;
    property: string;
    keyframes: Array<{
      id: string;
      time: number;
      value: number;
    }>;
    easing?: string;
  }>;
}

export interface AddElementPayload {
  id: string;
  type: 'video' | 'image' | 'text' | 'audio' | 'composition';
  assetId?: string;
  content?: string;
  style?: {
    fontSize?: number;
    color?: string;
    fontFamily?: string;
  };
  start: number;
  duration: number;
  trimStart?: number;
  trimDuration?: number;
  volume?: number;
  transform: {
    x: number;
    y: number;
    scale: number;
    rotation: number;
    opacity: number;
  };
}

export const api = {
  async getProject(projectPath?: string): Promise<ProjectData> {
    const response = await axios.get(buildApiUrl('/api/project'), {
      params: projectPath ? { path: projectPath } : withProjectPath()
    });
    return normalizeProjectContract(response.data).project as unknown as ProjectData;
  },

  async updateElement(projectPath: string | undefined, elementId: string, updates: Partial<ProjectData['elements'][0]>): Promise<ProjectData> {
    const response = await axios.post(buildApiUrl('/api/project/element'), {
      ...(projectPath ? { projectPath } : withProjectPath()),
      elementId,
      updates
    });
    return response.data;
  },

  async updateKeyframe(
    projectPath: string | undefined,
    elementId: string,
    property: string,
    keyframeIndex: number,
    value: number,
    opts?: { time?: number; easing?: string; keyframeId?: string }
  ): Promise<ProjectData> {
    const response = await axios.post(buildApiUrl('/api/project/keyframe'), {
      ...(projectPath ? { projectPath } : withProjectPath()),
      elementId,
      property,
      keyframeIndex,
      keyframeId: opts?.keyframeId,
      value,
      time: opts?.time,
      easing: opts?.easing
    });
    return response.data;
  },

  async addKeyframe(
    projectPath: string | undefined,
    elementId: string,
    property: string,
    time: number,
    value: number,
    easing?: string,
    keyframeId?: string
  ): Promise<ProjectData> {
    const response = await axios.post(buildApiUrl('/api/project/animation'), {
      ...(projectPath ? { projectPath } : withProjectPath()),
      elementId,
      property,
      time,
      value,
      easing,
      keyframeId
    });
    return response.data;
  },

  async getAudioWaveform(
    projectPath: string | undefined,
    opts: { assetId?: string; src?: string; samples?: number }
  ): Promise<{ peaks: number[]; cached: boolean }> {
    const response = await axios.get(buildApiUrl('/api/audio/waveform'), {
      params: projectPath
        ? {
            path: projectPath,
            assetId: opts.assetId,
            src: opts.src,
            samples: opts.samples
          }
        : withProjectPath({
            assetId: opts.assetId,
            src: opts.src,
            samples: opts.samples
          })
    });
    return response.data;
  },

  async uploadAsset(projectPath: string | undefined, file: File): Promise<{ assetId?: string; asset?: unknown }> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await axios.post(buildApiUrl('/api/assets'), formData, {
      params: projectPath ? { path: projectPath } : withProjectPath(),
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },

  async saveProject(projectPath: string | undefined, project: ProjectData): Promise<ProjectData> {
    const response = await axios.post(buildApiUrl('/api/project/save'), {
      ...(projectPath ? { projectPath } : withProjectPath()),
      project,
    });
    return normalizeProjectContract(response.data).project as unknown as ProjectData;
  }
};
