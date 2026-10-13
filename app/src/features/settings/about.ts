export const APP_VERSION: string = __APP_VERSION__;
export const versionLabel = (version: string) => /^\d+\.\d+\.\d+/.test(version) ? `v${version}` : version;
export const APP_VERSION_LABEL = versionLabel(APP_VERSION);
export const APP_COMMIT: string = __APP_COMMIT__;

export const REPO_URL = __PUBLIC_URLS__.HONGSI_REPO_URL;
export const SUPPORT_URL = __PUBLIC_URLS__.HONGSI_SUPPORT_URL;
