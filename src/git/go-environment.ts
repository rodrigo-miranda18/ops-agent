import path from 'node:path';

export function goDependencyEnvironment(cacheDir: string) {
  return {
    GOPATH: path.join(cacheDir, 'go-path'),
    GOCACHE: path.join(cacheDir, 'go-build'),
    GOMODCACHE: path.join(cacheDir, 'go-mod'),
  };
}
