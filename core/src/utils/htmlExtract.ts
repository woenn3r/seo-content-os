export type HtmlExtract = {
  title?: string;
  metaDescription?: string;
  h1?: string;
  headingsH2?: string[];
  headingsH3?: string[];
  mainText?: string;
};

export function extractHtml(_html: string): HtmlExtract {
  // Placeholder: real extraction will parse DOM + Readability.
  return {};
}
