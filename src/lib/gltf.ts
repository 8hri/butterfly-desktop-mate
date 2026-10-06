import { use } from "react";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * Minimal cached GLB loader.
 *
 * Promises are cached per URL, so a model loads once per page (StrictMode
 * double-rendering and remounts are free) and `use()` suspends only the
 * component that needs the asset.
 */
const cache = new Map<string, Promise<GLTF>>();

function loadGLTF(url: string): Promise<GLTF> {
  let pending = cache.get(url);
  if (!pending) {
    pending = new Promise<GLTF>((resolve, reject) => {
      new GLTFLoader().load(url, resolve, undefined, reject);
    });
    cache.set(url, pending);
  }
  return pending;
}

/** Warms the cache before the component mounts. */
export function preloadGLTF(url: string) {
  void loadGLTF(url);
}

export function useGLTF(url: string): GLTF {
  return use(loadGLTF(url));
}
