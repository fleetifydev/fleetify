import { describe, it, expect } from "vitest";
import {
  isHostPath,
  containerIdFromPath,
  normalizeBranches,
  EMPTY_BRANCHES,
  leafName,
  parentDir,
  relativeWithin,
} from "../exec-target";

describe("isHostPath", () => {
  /** The crash this module exists to prevent: picking a container set
   *  project_path to `docker://…`, the toolbar still ran host git against
   *  it, and the malformed result took the render down. */
  it("rejects container and remote targets", () => {
    expect(isHostPath("docker://abc123/work")).toBe(false);
    expect(isHostPath("ssh://me@host/srv")).toBe(false);
    // Unknown schemes too — a future podman:// must not be treated as a
    // host path, same rule the backend parser enforces.
    expect(isHostPath("podman://c1/work")).toBe(false);
    expect(isHostPath("wsl://distro/home")).toBe(false);
  });

  /** The flip side, and the reason the check is a scheme test rather than
   *  a colon test: a Windows drive letter is not a scheme. Getting this
   *  wrong would disable git for every Windows user. */
  it("accepts every shape of real filesystem path", () => {
    expect(isHostPath("C:\\Users\\me\\proj")).toBe(true);
    expect(isHostPath("\\\\?\\C:\\Users\\me\\proj")).toBe(true);
    expect(isHostPath("\\\\server\\share\\proj")).toBe(true);
    expect(isHostPath("/home/me/proj")).toBe(true);
    expect(isHostPath("/home/me/a:b")).toBe(true);
    expect(isHostPath("relative/path")).toBe(true);
  });

  it("treats an absent path as not host-workable", () => {
    expect(isHostPath(null)).toBe(false);
    expect(isHostPath(undefined)).toBe(false);
    expect(isHostPath("")).toBe(false);
  });
});

describe("containerIdFromPath", () => {
  it("splits at the first slash — ids cannot contain one", () => {
    expect(containerIdFromPath("docker://abc123/work/repo")).toBe("abc123");
    expect(containerIdFromPath("docker://my_app-1.2/srv")).toBe("my_app-1.2");
  });

  it("handles a marker with no path", () => {
    expect(containerIdFromPath("docker://abc123")).toBe("abc123");
  });

  it("returns null for anything that is not a container marker", () => {
    expect(containerIdFromPath("/home/me/proj")).toBeNull();
    expect(containerIdFromPath("ssh://me@host/srv")).toBeNull();
    expect(containerIdFromPath("docker://")).toBeNull();
    expect(containerIdFromPath(null)).toBeNull();
  });
});

describe("normalizeBranches", () => {
  /** The exact regression: `listGitBranches` against a container path came
   *  back non-null but without its arrays, and `branches.local.filter(...)`
   *  threw "Cannot read properties of undefined (reading 'filter')". */
  it("fills in arrays that the IPC left out", () => {
    expect(normalizeBranches({ current: "main" })).toEqual({
      local: [],
      remote: [],
      current: "main",
    });
    expect(normalizeBranches({})).toEqual(EMPTY_BRANCHES);
  });

  it("survives null, undefined and non-objects", () => {
    expect(normalizeBranches(null)).toEqual(EMPTY_BRANCHES);
    expect(normalizeBranches(undefined)).toEqual(EMPTY_BRANCHES);
    expect(normalizeBranches("nonsense")).toEqual(EMPTY_BRANCHES);
  });

  it("rejects a non-array where an array is required", () => {
    expect(normalizeBranches({ local: "main", remote: null, current: 7 })).toEqual(
      EMPTY_BRANCHES,
    );
  });

  it("passes a well-formed result through unchanged", () => {
    const good = { local: ["main", "dev"], remote: ["origin/main"], current: "dev" };
    expect(normalizeBranches(good)).toEqual(good);
  });

  /** Whatever comes back, the render's `.filter` must be safe. */
  it("always returns something the render can filter", () => {
    for (const input of [null, {}, { local: 1 }, "x", [], { remote: {} }]) {
      const b = normalizeBranches(input);
      expect(() => b.local.filter(Boolean)).not.toThrow();
      expect(() => b.remote.filter(Boolean)).not.toThrow();
    }
  });
});

describe("project-file path helpers", () => {
  /** The dialog hands back OS-native absolute paths; every helper has to
   *  survive Windows separators and drive-letter casing. */
  it("takes leaves and parents across both separator styles", () => {
    expect(leafName("C:\\proj\\docker\\Dockerfile.dev")).toBe("Dockerfile.dev");
    expect(leafName("/home/me/proj/compose.yaml")).toBe("compose.yaml");
    expect(parentDir("C:\\proj\\docker\\Dockerfile.dev")).toBe("C:/proj/docker");
    expect(parentDir("/home/me/proj/compose.yaml")).toBe("/home/me/proj");
  });

  it("relativises a file inside the project, with forward slashes", () => {
    expect(relativeWithin("C:\\proj\\docker\\Dockerfile.dev", "C:\\proj")).toBe(
      "docker/Dockerfile.dev",
    );
    expect(relativeWithin("/home/me/proj/compose.yaml", "/home/me/proj")).toBe(
      "compose.yaml",
    );
  });

  /** Same place, different drive-letter casing — the classic Windows trap.
   *  Failing this stores an absolute path where a relative one was right. */
  it("ignores drive-letter casing on Windows-shaped paths only", () => {
    expect(relativeWithin("c:\\Proj\\Dockerfile", "C:\\proj")).toBe("Dockerfile");
    // POSIX stays case-sensitive: /home/ME is a different directory.
    expect(relativeWithin("/home/ME/proj/f", "/home/me/proj")).toBeNull();
  });

  it("returns null for a file outside the project", () => {
    expect(relativeWithin("D:\\elsewhere\\Dockerfile", "C:\\proj")).toBeNull();
    expect(relativeWithin("/tmp/other/compose.yaml", "/home/me/proj")).toBeNull();
    // A sibling whose name merely EXTENDS the folder's must not match.
    expect(relativeWithin("/home/me/proj2/f", "/home/me/proj")).toBeNull();
  });
});
