
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminProductDto } from "../../src/shared/ipcContract";

const h = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  refs: [] as Array<{ current: unknown }>,
  effects: [] as Array<{ deps: readonly unknown[]; cleanup?: () => void }>,
  pending: [] as Array<() => void>,
  refIndex: 0,
  effectIndex: 0,
  requests: new Map<string, (value: unknown) => void>(),
}));
vi.mock("react", () => ({
  useState: () => [h.cache, (f: (prev: Map<string, unknown>) => Map<string, unknown>) => { h.cache = f(h.cache); }],
  useRef: (value: unknown) => {
    const i = h.refIndex++;
    return h.refs[i] ?? (h.refs[i] = { current: value });
  },
  useEffect: (f: () => void | (() => void), deps: readonly unknown[]) => {
    const i = h.effectIndex++;
    const previous = h.effects[i];
    if (previous && deps.length === previous.deps.length && deps.every((v, n) => Object.is(v, previous.deps[n]))) return;
    previous?.cleanup?.();
    const effect: { deps: readonly unknown[]; cleanup?: () => void } = { deps };
    h.effects[i] = effect;
    h.pending.push(() => { const cleanup = f(); if (cleanup) effect.cleanup = cleanup; });
  },
}));
vi.mock("../../src/renderer/api", () => ({
  call: (p: unknown) => p,
  pos: () => ({ getProductImageBytes: ({ imageId }: { imageId: string }) => new Promise((resolve) => h.requests.set(imageId, resolve)) }),
}));
import { useThumbnails } from "../../src/renderer/useThumbnails";
function render(rows: readonly AdminProductDto[]) {
  h.refIndex = 0; h.effectIndex = 0;
  useThumbnails(rows);
  for (const effect of h.pending.splice(0)) effect();
}
function product(id: string): AdminProductDto {
  return { id, primaryImageId: "image-" + id, imageVersion: "v1" } as AdminProductDto;
}
describe("thumbnail request across visible cart changes", () => {
  beforeEach(() => {
    h.cache = new Map(); h.refs = []; h.effects = []; h.pending = []; h.requests = new Map();
  });

  it("does not overwrite a newer image with a late old response", async () => {
    const oldPhoto = product("a");
    const newer = { ...oldPhoto, primaryImageId: "image-a-new", imageVersion: "v2" };
    render([oldPhoto]); render([newer]);
    h.requests.get("image-a-new")!({ bytes: [2], meta: { mime: "image/jpeg" } });
    await vi.waitFor(() => expect(h.cache.get("a")).toMatchObject({ kind: "ready", version: "v2" }));
    h.requests.get("image-a")!({ bytes: [1], meta: { mime: "image/jpeg" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.cache.get("a")).toMatchObject({ kind: "ready", version: "v2" });
  });
  it("does not update the cache after the component unmounts", async () => {
    render([product("a")]);
    for (const effect of h.effects) effect.cleanup?.();
    h.requests.get("image-a")!({ bytes: [1], meta: { mime: "image/jpeg" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.cache.get("a")).toMatchObject({ kind: "loading", version: "v1" });
  });
  it("settles an in-flight image after the visible rows change", async () => {
    const first = product("a"), second = product("b");
    render([first]);
    render([first, second]);
    h.requests.get("image-a")!({ bytes: [1], meta: { mime: "image/jpeg" } });
    await vi.waitFor(() => expect(h.cache.get("a")).toMatchObject({ kind: "ready", version: "v1" }));
  });
});
