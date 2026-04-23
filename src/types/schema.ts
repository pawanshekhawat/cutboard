// CutBoard v1 Schema Types

export const SCHEMA_VERSION = '1.0';

// ─── Meta ───────────────────────────────────────────────────────────────────
export interface Resolution {
  width: number;
  height: number;
}

export interface Meta {
  name: string;
  fps: number;
  resolution: Resolution;
  duration: number; // seconds, computed from elements
}

// ─── Assets ────────────────────────────────────────────────────────────────
export type AssetType = 'video' | 'image' | 'audio';

export interface BaseAsset {
  type: AssetType;
  src: string; // relative path from project root
}

export interface VideoAsset extends BaseAsset {
  type: 'video';
  duration: number; // seconds — probed from file
}

export interface ImageAsset extends BaseAsset {
  type: 'image';
}

export interface AudioAsset extends BaseAsset {
  type: 'audio';
}

export type Asset = VideoAsset | ImageAsset | AudioAsset;

export type Assets = Record<string, Asset>;

// ─── Transform ─────────────────────────────────────────────────────────────
export interface Transform {
  x: number;
  y: number;
  scale: number;
  rotation: number; // degrees
  opacity: number;   // 0–1
}

// ─── Elements ──────────────────────────────────────────────────────────────
export type ElementType = 'video' | 'image' | 'text' | 'audio';

export interface BaseElement {
  id: string;
  type: ElementType;
  start: number;   // seconds — global timeline position
  duration: number; // seconds — how long it appears
  transform: Transform;
}

export interface VideoElement extends BaseElement {
  type: 'video';
  assetId: string;
  trimStart: number;  // seconds — seek into the source clip (0 = from start)
  trimDuration: number; // seconds — how much of the source to use
}

export interface ImageElement extends BaseElement {
  type: 'image';
  assetId: string;
}

export interface TextElement extends BaseElement {
  type: 'text';
  content: string;
  style: TextStyle;
}

export interface AudioElement extends BaseElement {
  type: 'audio';
  assetId: string;
}

export interface TextStyle {
  fontSize: number;
  color: string;     // hex
  fontFamily?: string;
  fontWeight?: number;
  textAlign?: 'left' | 'center' | 'right';
}

export type Element = VideoElement | ImageElement | TextElement | AudioElement;

export type Elements = Record<string, Element>;

// ─── Tracks ────────────────────────────────────────────────────────────────
export type TrackType = 'video' | 'image' | 'text' | 'audio' | 'overlay';

export interface Track {
  id: string;
  type: TrackType;
  label?: string;
  elements: string[]; // element IDs, ordered
}

export type Tracks = Track[];

// ─── Animations ────────────────────────────────────────────────────────────
export type EasingType = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'spring';

export interface Keyframe {
  time: number;  // seconds (global timeline)
  value: number;
}

export interface Animation {
  id: string;
  target: string;      // element ID
  property: string;    // e.g. "transform.scale", "transform.x", "opacity"
  keyframes: Keyframe[];
  easing: EasingType;
}

export type Animations = Record<string, Animation>;

// ─── Effects ────────────────────────────────────────────────────────────────
export type EffectType = 'blur' | 'brightness' | 'contrast' | 'saturation' | 'grayscale';

export interface Effect {
  id: string;
  target: string; // element ID
  type: EffectType;
  value: number;
}

export type Effects = Record<string, Effect>;

// ─── Root Project ───────────────────────────────────────────────────────────
export interface Project {
  version: typeof SCHEMA_VERSION;
  meta: Meta;
  assets: Assets;
  tracks: Tracks;
  elements: Elements;
  animations: Animations;
  effects: Effects;
}