export interface PlatformInvocationOptions {
  platform?: NodeJS.Platform;
  comspec?: string;
}

export interface PlatformInvocation {
  command: string;
  args: string[];
}

export function platformInvocation(
  command: string,
  args: string[],
  options?: PlatformInvocationOptions,
): PlatformInvocation;
