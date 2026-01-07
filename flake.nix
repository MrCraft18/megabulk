{
    description = "A nodejs cli tool for bulk downloading mega.nz links";

    inputs = {
        nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    };

    outputs = { self, nixpkgs }: let
        systems = [ "x86_64-linux" "aarch64-linux" ];
        forAllSystems = nixpkgs.lib.genAttrs systems;

        dependencies = pkgs: with pkgs; [
            nodejs
        ];
    in {
        # packages = forAllSystems (system: let
        #     pkgs = import nixpkgs { inherit system; };
        # in {
        #     default = pkgs.writeShellApplication {
        #         name = "megabulk";
        #         runtimeInputs = dependencies pkgs;
        #         text = builtins.readFile ./megabulk.sh;
        #     };
        # });
        #
        # apps = forAllSystems (system: {
        #     default = {
        #         type = "app";
        #         program = "${self.packages.${system}.default}/bin/megabulk";
        #     };
        # });

        devShells = forAllSystems (system: let
            pkgs = import nixpkgs { inherit system; };
        in {
            default = pkgs.mkShell {
                packages = dependencies pkgs;

                shellHook = ''
                    export NPM_CONFIG_PREFIX="$HOME/.npm"

                    if [[ $- == *i* ]]; then
                        exec zsh
                    fi
                '';
            };
        });
    };
}
