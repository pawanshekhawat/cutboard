import axios from 'axios';

const API_BASE = 'http://localhost:3001';

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
    type: 'video' | 'image' | 'audio';
    src: string;
    duration?: number;
  }>;
  elements: Record<string, {
    id: string;
    type: 'video' | 'image' | 'text' | 'audio';
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
      time: number;
      value: number;
      easing?: string;
    }>;
  }>;
}

export const api = {
  async getProject(projectPath: string): Promise<ProjectData> {
    const response = await axios.get(`${API_BASE}/api/project`, {
      params: { path: projectPath }
    });
    return response.data;
  },

  async updateElement(projectPath: string, elementId: string, updates: Partial<ProjectData['elements'][0]>): Promise<ProjectData> {
    const response = await axios.post(`${API_BASE}/api/project/element`, {
      projectPath,
      elementId,
      updates
    });
    return response.data;
  },

  async updateKeyframe(
    projectPath: string,
    elementId: string,
    property: string,
    keyframeIndex: number,
    value: number
  ): Promise<ProjectData> {
    const response = await axios.post(`${API_BASE}/api/project/keyframe`, {
      projectPath,
      elementId,
      property,
      keyframeIndex,
      value
    });
    return response.data;
  },

  async addKeyframe(
    projectPath: string,
    elementId: string,
    property: string,
    time: number,
    value: number,
    easing?: string
  ): Promise<ProjectData> {
    const response = await axios.post(`${API_BASE}/api/project/animation`, {
      projectPath,
      elementId,
      property,
      time,
      value,
      easing
    });
    return response.data;
  }
};
