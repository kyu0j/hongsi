declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __PUBLIC_URLS__: Record<string, string>;

declare module 'virtual:dependency-info' {
  const groups: { id: string; title: string; items: { name: string; url: string }[] }[];
  export default groups;
}
