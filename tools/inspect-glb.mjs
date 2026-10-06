/**
 * Analysis helper (dev only): prints world-space bounds of a GLB by walking
 * the scene graph and transforming accessor bounds, so we can verify model
 * orientation and size without guessing from screenshots.
 */
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? "public/assets/animated_butterfly.glb";
const buf = readFileSync(file);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));

// Multiply column-major 4x4 matrices (glTF order).
function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

function nodeMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  const [x, y, z, w] = r;
  // Quaternion to rotation matrix (column-major).
  const rot = [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
  const scale = [s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1];
  const trans = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
  return mul(trans, mul(rot, scale));
}

const world = new Map();
function walk(index, parent) {
  const node = gltf.nodes[index];
  const m = mul(parent, nodeMatrix(node));
  world.set(index, m);
  for (const child of node.children ?? []) walk(child, m);
}
for (const root of gltf.scenes[gltf.scene ?? 0].nodes ?? []) walk(root, identity());
function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
const perMesh = [];

gltf.nodes.forEach((node, i) => {
  if (node.mesh === undefined) return;
  const m = world.get(i) ?? identity();
  const mesh = gltf.meshes[node.mesh];
  const local = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const prim of mesh.primitives) {
    const acc = gltf.accessors[prim.attributes.POSITION];
    for (let c = 0; c < 8; c++) {
      const p = [
        c & 1 ? acc.max[0] : acc.min[0],
        c & 2 ? acc.max[1] : acc.min[1],
        c & 4 ? acc.max[2] : acc.min[2],
      ];
      const w = [
        m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
        m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
        m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
      ];
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], w[a]);
        max[a] = Math.max(max[a], w[a]);
        local.min[a] = Math.min(local.min[a], w[a]);
        local.max[a] = Math.max(local.max[a], w[a]);
      }
    }
  }
  perMesh.push({
    name: mesh.name,
    size: local.max.map((v, a) => +(v - local.min[a]).toFixed(4)),
    center: local.max.map((v, a) => +((v + local.min[a]) / 2).toFixed(4)),
  });
});

console.log("world min:", min.map((v) => +v.toFixed(4)));
console.log("world max:", max.map((v) => +v.toFixed(4)));
console.log("world size:", max.map((v, a) => +(v - min[a]).toFixed(4)));
console.log("world center:", max.map((v, a) => +((v + min[a]) / 2).toFixed(4)));
console.table(perMesh);
