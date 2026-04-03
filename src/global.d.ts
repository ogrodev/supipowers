// Allow importing .md files (required by @oh-my-pi/pi-ai transitive imports)
declare module "*.md" {
  const content: string;
  export default content;
}
