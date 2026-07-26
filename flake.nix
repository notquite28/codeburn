{
  description = "codeburn (fork) dev shell - node 22 for building and running";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.flake-utils.url = "github:numtide/flake-utils";

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        # codeburn's package.json requires node >=22.13
        node = pkgs.nodejs_22;
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
            node
            # corepack ships with nodejs_22; pnpm/bun callers can enable it
            # themselves, but npm (bundled) is enough for this repo
          ];
          shellHook = ''
            echo ""
            echo "codeburn dev shell (nix flake)"
            echo "  node: $(node --version)   npm: $(npm --version)"
            echo "  build:   npm run build"
            echo "  test:    npx vitest"
            echo "  run:     npm run dev -- <cmd>   # or: node dist/cli.js"
            echo ""
          '';
        };
      });
}
