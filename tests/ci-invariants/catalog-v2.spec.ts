// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/catalog-v2`
 * Purpose: Enforces catalog v2 shape + cross-file invariants. Replaces the
 *          decorative-only `infra/catalog/_schema.json` with executable checks
 *          that gate merge. See docs/spec/catalog-v2.md.
 * Scope: Static structural test that does NOT shell out to git, docker, kubectl, or any network. Reads every `infra/catalog/*.yaml` and asserts schema shape + cross-file uniqueness + dockerfile-on-disk + role rules.
 * Invariants:
 *   - SCHEMA_VERSION_IS_2
 *   - CATALOG_NAME_MATCHES_FILENAME
 *   - NODE_REQUIRES_NODE_ID
 *   - DEPLOY_BLOCK_SHAPED
 *   - EXACTLY_ONE_APP_PER_DEPLOY_UNIT
 *   - IMAGE_NAME_UNIQUE_REPO_WIDE
 *   - IMAGE_TAG_TUPLE_UNIQUE_REPO_WIDE   (image_name, image_tag_suffix)
 *   - DOCKERFILE_RESOLVES_ON_DISK
 *   - PUBLIC_URL_HTTPS_ONLY
 * Side-effects: IO (reads infra/catalog/*.yaml + stats Dockerfile paths)
 * Notes: Adding or modifying a catalog file without satisfying these invariants
 *        causes this test to fail with an actionable message.
 * Links: docs/spec/catalog-v2.md, infra/catalog/_schema.json, scripts/ci/lib/image-tags.sh
 * @public
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CATALOG_DIR = path.join(REPO_ROOT, "infra/catalog");

interface CatalogImage {
  name: string;
  role: "app" | "migrator" | "sidecar";
  dockerfile: string;
  image_name: string;
  image_tag_suffix: string;
  path_prefix?: string;
  build?: {
    context?: string;
    target?: string;
    test_target?: string;
    cache_scope?: string;
  };
}

interface Catalog {
  schema_version: number;
  name: string;
  type: "node" | "service";
  node_id?: string;
  deploy: {
    candidate_a_branch: string;
    preview_branch: string;
    production_branch: string;
    path_prefix: string;
    port?: number;
    public_url?: {
      "candidate-a"?: string;
      preview?: string;
      production?: string;
    };
  };
  images: CatalogImage[];
}

function listCatalogFiles(): string[] {
  return readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .filter((f) => !f.startsWith("_"))
    .sort();
}

function loadCatalog(filename: string): Catalog {
  return yaml.parse(
    readFileSync(path.join(CATALOG_DIR, filename), "utf8")
  ) as Catalog;
}

const CATALOGS = listCatalogFiles().map((f) => ({
  filename: f,
  doc: loadCatalog(f),
}));

describe("catalog v2 per-file shape", () => {
  for (const { filename, doc } of CATALOGS) {
    describe(filename, () => {
      it("declares schema_version: 2", () => {
        expect(doc.schema_version).toBe(2);
      });

      it("name matches filename", () => {
        expect(`${doc.name}.yaml`).toBe(filename);
      });

      it("type is node or service", () => {
        expect(["node", "service"]).toContain(doc.type);
      });

      it("node type requires node_id (UUID v4)", () => {
        if (doc.type === "node") {
          expect(doc.node_id).toBeDefined();
          expect(doc.node_id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
          );
        }
      });

      it("deploy block has required fields", () => {
        expect(doc.deploy).toBeDefined();
        expect(doc.deploy.candidate_a_branch).toMatch(
          /^deploy\/candidate-a-[a-z0-9-]+$/
        );
        expect(doc.deploy.preview_branch).toMatch(
          /^deploy\/preview-[a-z0-9-]+$/
        );
        expect(doc.deploy.production_branch).toMatch(
          /^deploy\/production-[a-z0-9-]+$/
        );
        expect(doc.deploy.path_prefix).toMatch(/^[a-z0-9._/-]+\/$/);
      });

      it("deploy branches all carry the catalog name as suffix", () => {
        expect(doc.deploy.candidate_a_branch).toBe(
          `deploy/candidate-a-${doc.name}`
        );
        expect(doc.deploy.preview_branch).toBe(`deploy/preview-${doc.name}`);
        expect(doc.deploy.production_branch).toBe(
          `deploy/production-${doc.name}`
        );
      });

      it("public_url entries are https://", () => {
        const pu = doc.deploy.public_url;
        if (!pu) return;
        for (const [env, url] of Object.entries(pu)) {
          expect(url, `${env} must be https://`).toMatch(/^https:\/\//);
        }
      });

      it("images[] has ≥1 entry", () => {
        expect(Array.isArray(doc.images)).toBe(true);
        expect(doc.images.length).toBeGreaterThanOrEqual(1);
      });

      it("exactly one image has role: app", () => {
        const apps = doc.images.filter((i) => i.role === "app");
        expect(apps.length).toBe(1);
      });

      it("each image has required fields", () => {
        for (const img of doc.images) {
          expect(img.name).toMatch(/^[a-z][a-z0-9-]*$/);
          expect(["app", "migrator", "sidecar"]).toContain(img.role);
          expect(img.dockerfile).toMatch(/^[a-z0-9._/-]+\/Dockerfile$/);
          expect(img.image_name).toMatch(
            /^ghcr\.io\/cogni-dao\/[a-z][a-z0-9-]*$/
          );
          expect(img.image_tag_suffix).toMatch(/^(-[a-z0-9-]+)?$/);
        }
      });

      it("each image's dockerfile resolves on disk", () => {
        for (const img of doc.images) {
          const p = path.join(REPO_ROOT, img.dockerfile);
          expect(
            existsSync(p),
            `${doc.name}/${img.name} dockerfile missing: ${img.dockerfile}`
          ).toBe(true);
        }
      });
    });
  }
});

describe("catalog v2 cross-file invariants", () => {
  it("image.name is unique repo-wide", () => {
    const seen = new Map<string, string>();
    for (const { filename, doc } of CATALOGS) {
      for (const img of doc.images) {
        const prior = seen.get(img.name);
        expect(
          prior,
          `image.name=${img.name} declared in both ${prior} and ${filename}`
        ).toBeUndefined();
        seen.set(img.name, filename);
      }
    }
  });

  it("(image_name, image_tag_suffix) tuple is unique repo-wide", () => {
    const seen = new Map<string, string>();
    for (const { filename, doc } of CATALOGS) {
      for (const img of doc.images) {
        const key = `${img.image_name}:::${img.image_tag_suffix}`;
        const prior = seen.get(key);
        expect(
          prior,
          `(image_name=${img.image_name}, image_tag_suffix=${img.image_tag_suffix}) collision: ${prior} vs ${filename}`
        ).toBeUndefined();
        seen.set(key, filename);
      }
    }
  });

  it("within a deploy unit, no two images share image_name", () => {
    for (const { filename, doc } of CATALOGS) {
      const seen = new Map<string, string>();
      for (const img of doc.images) {
        const prior = seen.get(img.image_name);
        expect(
          prior,
          `${filename}: images[].image_name=${img.image_name} collides between ${prior} and ${img.name} — kustomize images[] block keys on name:`
        ).toBeUndefined();
        seen.set(img.image_name, img.name);
      }
    }
  });

  it("deploy unit names are unique (filename invariant)", () => {
    const names = CATALOGS.map(({ doc }) => doc.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
