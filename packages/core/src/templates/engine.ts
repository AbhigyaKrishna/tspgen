import { Eta } from "eta";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface TemplateLayer {
  name: string;
  dir: string;
}

export class TemplateNotFoundError extends Error {}

/**
 * Eta renderer resolving logical template names (e.g. "kotlin/model/data-class") through ordered
 * layers; the first layer containing `<name>.eta` wins. Includes resolve the same way.
 */
export class TemplateEngine {
  private readonly eta: Eta;

  constructor(
    private readonly layers: readonly TemplateLayer[],
    private readonly helpers: Record<string, unknown> = {},
  ) {
    this.eta = new Eta({ autoEscape: false, autoTrim: false, cache: false });
    this.eta.resolvePath = (name: string) => this.resolve(name).path;
  }

  resolve(name: string): { layer: string; path: string } {
    for (const layer of this.layers) {
      const path = join(layer.dir, `${name}.eta`);
      if (existsSync(path)) return { layer: layer.name, path };
    }
    throw new TemplateNotFoundError(
      `Template '${name}' not found in layers: ${this.layers.map((l) => l.name).join(", ")}`,
    );
  }

  render(name: string, data: Record<string, unknown>): string {
    return this.eta.render(name, { ...data, h: this.helpers });
  }
}
