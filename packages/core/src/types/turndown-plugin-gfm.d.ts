/**
 * Ambient types for `turndown-plugin-gfm`, which ships none of its own.
 * Only the members Crawlette actually uses are declared.
 */
declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';

  export const gfm: (service: TurndownService) => void;
  export const tables: (service: TurndownService) => void;
  export const strikethrough: (service: TurndownService) => void;
  export const taskListItems: (service: TurndownService) => void;
  export const highlightedCodeBlock: (service: TurndownService) => void;
}
