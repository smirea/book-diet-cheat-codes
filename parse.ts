#!/usr/bin/env bun
/**
 * Diet Cheat Codes PDF Parser
 *
 * Parses the cookbook PDF into structured markdown files using Gemini 2.5 Flash.
 * Supports resuming from where it left off via progress.json.
 *
 * Usage: bun run parse.ts <pdf-path>
 */

import { $ } from 'bun';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from 'fs';
import { join } from 'path';

const CONFIG = {
  pdfPath: '',
  outputDir: process.cwd(),
  recipesDir: join(process.cwd(), 'recipes'),
  imagesDir: join(process.cwd(), 'images'),
  progressFile: join(process.cwd(), 'progress.json'),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: 'gemini-2.5-flash',
  totalPages: 475,
  overviewPages: {
    intro: { start: 8, end: 15 },
    pantry: { start: 16, end: 19 },
    kitchen: { start: 20, end: 25 },
    techniques: { start: 26, end: 44 },
    reference: { start: 461, end: 474 },
  },
  recipeStartPage: 45,
  recipeEndPage: 460,
};

const PDF_DOWNLOAD_URL = 'https://dietcheatcodes.com/d/confirm_email/7a94da0fdbc3593a523a9ac8d5ab1658be59efcd';

const CATEGORY_MAP: Record<string, string> = {
  'breakfast bliss': 'breakfast-bliss',
  'midday munchies': 'midday-munchies',
  'dinner is served': 'dinner-is-served',
  'sweet treats': 'sweet-treats',
  'blender ice cream': 'blender-ice-cream',
  'ice cream pints': 'ice-cream-pints',
  'fruit sorbets': 'fruit-sorbets',
  'cookie dough': 'cookie-dough',
  'shareables': 'shareables',
  "let's get saucy": 'lets-get-saucy',
  'doughlicious': 'doughlicious',
  'prep school': 'prep-school',
  'protein ice cream': 'protein-ice-cream',
};

const LEGACY_PREFIX_PRIORITY: Record<string, string[]> = {
  'breakfast-bliss': ['breakfast', 'breakfast-bliss'],
  'midday-munchies': ['lunch', 'midday-munchies'],
  'dinner-is-served': ['dinner', 'dinner-is-served'],
  'sweet-treats': ['desserts', 'sweet-treats'],
  'blender-ice-cream': ['blender-ice-cream'],
  'ice-cream-pints': ['ice-cream', 'ice-cream-pints'],
  'fruit-sorbets': ['sorbets', 'fruit-sorbets'],
  'cookie-dough': ['cookie-dough'],
  'shareables': ['sides', 'shareables'],
  'lets-get-saucy': ['sauces', 'lets-get-saucy'],
  'doughlicious': ['breads', 'doughlicious'],
  'prep-school': ['meal-prep', 'prep-school'],
};

const CATEGORY_PATTERNS: Array<{ slug: string; patterns: RegExp[] }> = [
  { slug: 'breakfast-bliss', patterns: [/BREAKFAST\s*BLISS/i] },
  { slug: 'midday-munchies', patterns: [/MIDDAY\s*MUNCHIES/i] },
  { slug: 'dinner-is-served', patterns: [/DINNER\s*IS\s*SERVED/i] },
  { slug: 'sweet-treats', patterns: [/SWEET\s*TREATS/i] },
  { slug: 'blender-ice-cream', patterns: [/BLENDER\s*ICE\s*CREAM/i] },
  { slug: 'ice-cream-pints', patterns: [/ICE\s*CREAM\s*PINTS/i] },
  { slug: 'fruit-sorbets', patterns: [/FRUIT\s*SORBETS/i] },
  { slug: 'cookie-dough', patterns: [/COOKIE\s*DOUGH/i] },
  { slug: 'shareables', patterns: [/SHARE\s*-?\s*ABLES/i, /SHAREABLES/i] },
  { slug: 'lets-get-saucy', patterns: [/LET[’']?S\s*GET\s*SAUCY/i] },
  { slug: 'doughlicious', patterns: [/DOUGH\s*-?\s*LICIOUS/i] },
  { slug: 'prep-school', patterns: [/PREP\s*SCHOOL/i] },
];

const HARD_BOUNDARY_PATTERNS: RegExp[] = [
  /REFERENCE\s*TABLES?/i,
  /RECIPE\s*PAGE\s*BREAKDOWN/i,
  /MASTER\s*RECIPE\s*NUTRITION\s*TABLE/i,
  /M\s*E\s*A\s*T\s*\+\s*S\s*E\s*A\s*F\s*O\s*O\s*D\s*M\s*A\s*C\s*R\s*O\s*S/i,
  /FRUIT\s*MACROS/i,
  /VEGETABLE\s*MACROS/i,
  /SEASONING\s*MACROS/i,
  /SATIETY\s*INDEX/i,
];

interface Progress {
  lastUpdated: string;
  overviewComplete: boolean;
  recipesProcessed: string[];
  pagesProcessed: number[];
  rangeKeysProcessed: string[];
  currentPage: number;
  totalRecipes: number;
  errors: Array<{ page: number; error: string; timestamp: string }>;
}

interface Recipe {
  name: string;
  category: string;
  serves: string;
  prepTime: string;
  cookTime: string;
  macros: {
    calories: number;
    fat: string;
    carbs: string;
    netCarbs: string;
    protein: string;
  };
  ingredients: Array<{
    section: string;
    items: string[];
  }>;
  directions: string[];
  tips: string;
  notes: string;
}

interface PageMeta {
  page: number;
  wordCount: number;
  isRecipeStart: boolean;
  isContinuation: boolean;
  isImageLike: boolean;
  isBoundary: boolean;
  sectionHint?: string;
}

interface RecipeRange {
  startPage: number;
  endPage: number;
  pages: number[];
  rangeKey: string;
  nameHint?: string;
  sectionHint?: string;
}

interface RangeScanResult {
  pageTexts: string[];
  pageMetas: PageMeta[];
  recipeRanges: RecipeRange[];
  recipeStartPage: number;
  recipeEndPage: number;
  referenceStartPage: number;
  totalPages: number;
}

interface ProcessingStats {
  processed: number;
  skipped: number;
  failed: number;
  keepRecipeFiles: Set<string>;
  keepImageFiles: Set<string>;
}

interface RecipeTableEntry {
  name: string;
  section: string;
  ratio: number;
  calories: string;
  protein: string;
  fat: string;
  carbs: string;
  fiber: string;
  file: string;
}

interface RecipeOutput {
  filename: string;
  imageFilenames: string[];
}

let runtimeTotalPages = CONFIG.totalPages;
let runtimeRecipeStartPage = CONFIG.recipeStartPage;
let runtimeRecipeEndPage = CONFIG.recipeEndPage;
let runtimeReferenceRange = { ...CONFIG.overviewPages.reference };
let cachedRangeScan: RangeScanResult | null = null;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’'"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function cleanMacroValue(value: string): string {
  const trimmed = String(value).trim();
  const normalized = trimmed.toLowerCase();
  if (trimmed === '' || normalized === 'n/a' || normalized === 'undefined' || normalized === 'null') {
    return 'N/A';
  }
  if (trimmed === '0') {
    return '0';
  }
  const match = trimmed.match(/^(\d+(?:\.\d+)?)/);
  return match ? match[1] : trimmed;
}

function getCategorySlug(category: string): string {
  const normalized = category.toLowerCase().trim();
  return CATEGORY_MAP[normalized] || slugify(category);
}

function titleCaseSlug(slug: string): string {
  if (!slug.trim()) {
    return '';
  }
  return slug
    .split('-')
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function parseNumericValue(value: string): number | null {
  const normalized = String(value).trim();
  if (!normalized || normalized.toUpperCase() === 'N/A' || normalized.toLowerCase() === 'undefined') {
    return null;
  }
  const match = normalized.match(/-?\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }
  const parsed = parseFloat(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(2).replace(/\.?0+$/, '');
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, '\\|').trim();
}

async function runCommand(cmd: string): Promise<string> {
  const result = await $`sh -c ${cmd}`.quiet().nothrow();
  return result.stdout.toString();
}

function expandHomePath(path: string): string {
  if (!path.startsWith('~')) {
    return path;
  }
  const home = process.env.HOME || '';
  if (!home) {
    return path;
  }
  return path === '~' ? home : join(home, path.slice(2));
}

function configureOutputPaths(outputDir: string): void {
  const resolvedOutputDir = expandHomePath(outputDir);
  CONFIG.outputDir = resolvedOutputDir;
  CONFIG.recipesDir = join(resolvedOutputDir, 'recipes');
  CONFIG.imagesDir = join(resolvedOutputDir, 'images');
  CONFIG.progressFile = join(resolvedOutputDir, 'progress.json');
}

function createDefaultProgress(): Progress {
  return {
    lastUpdated: new Date().toISOString(),
    overviewComplete: false,
    recipesProcessed: [],
    pagesProcessed: [],
    rangeKeysProcessed: [],
    currentPage: CONFIG.recipeStartPage,
    totalRecipes: 0,
    errors: [],
  };
}

function normalizeProgress(progress: Partial<Progress>): Progress {
  const recipesProcessed = Array.from(new Set(progress.recipesProcessed || [])).sort();
  const pagesProcessed = Array.from(new Set(progress.pagesProcessed || [])).sort((a, b) => a - b);
  const rangeKeysProcessed = Array.from(new Set(progress.rangeKeysProcessed || [])).sort();
  return {
    lastUpdated: progress.lastUpdated || new Date().toISOString(),
    overviewComplete: Boolean(progress.overviewComplete),
    recipesProcessed,
    pagesProcessed,
    rangeKeysProcessed,
    currentPage: progress.currentPage && progress.currentPage > 0 ? progress.currentPage : CONFIG.recipeStartPage,
    totalRecipes: recipesProcessed.length,
    errors: Array.isArray(progress.errors) ? progress.errors : [],
  };
}

function readProgressFile(filePath: string): Progress | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const data = readFileSync(filePath, 'utf-8');
    return normalizeProgress(JSON.parse(data));
  } catch {
    return null;
  }
}

function loadProgress(): Progress {
  return readProgressFile(CONFIG.progressFile) || createDefaultProgress();
}

function saveProgress(progress: Progress): void {
  progress.lastUpdated = new Date().toISOString();
  progress.totalRecipes = Array.from(new Set(progress.recipesProcessed)).length;
  writeFileSync(CONFIG.progressFile, JSON.stringify(progress, null, 2));
}

function log(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.log(`[${timestamp}] ${message}`);
}

function logError(message: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  console.error(`[${timestamp}] ERROR: ${message}`);
}

async function initializePdfLayout(): Promise<void> {
  const info = await runCommand(`pdfinfo "${CONFIG.pdfPath}"`);
  const pagesMatch = info.match(/Pages:\s+(\d+)/);
  if (!pagesMatch) {
    log('Could not read PDF page count from pdfinfo, using configured page ranges');
    runtimeTotalPages = CONFIG.totalPages;
    runtimeRecipeStartPage = CONFIG.recipeStartPage;
    runtimeRecipeEndPage = CONFIG.recipeEndPage;
    runtimeReferenceRange = { ...CONFIG.overviewPages.reference };
    return;
  }
  runtimeTotalPages = parseInt(pagesMatch[1], 10);
}

function getPageTextWordCount(pageText: string): number {
  return pageText
    .replace(/\r/g, '\n')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean).length;
}

function detectCategoryHint(pageText: string): string | undefined {
  for (const category of CATEGORY_PATTERNS) {
    if (category.patterns.some(pattern => pattern.test(pageText))) {
      return category.slug;
    }
  }
  return undefined;
}

function extractRecipeNameFromPageText(text: string): string | null {
  const normalizedText = text.replace(/\r/g, '\n').replace(/\f/g, '\n');
  const servesMatch = normalizedText.match(/\bSERVES\b/i);
  if (!servesMatch || servesMatch.index === undefined) {
    return null;
  }

  const headerText = normalizedText
    .slice(0, servesMatch.index)
    .replace(/DIET\s+CHEAT\s+CODES/ig, ' ')
    .replace(/\b\d+\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!headerText) {
    return null;
  }

  const blockedHeaders = new Set(['REFERENCE', 'REFERENCE TABLES', 'PREP SCHOOL']);
  if (blockedHeaders.has(headerText.toUpperCase())) {
    return null;
  }

  return headerText;
}

function classifyPage(
  page: number,
  pageText: string,
  currentSectionHint?: string
): { meta: PageMeta; nextSectionHint?: string } {
  const wordCount = getPageTextWordCount(pageText);
  const hasServes = /\bSERVES\b/i.test(pageText);
  const hasIngredients = /\bINGREDIENTS\b/i.test(pageText);
  const hasDirections = /\bDIRECTIONS\b/i.test(pageText);
  const hasMacros = /\bMACROS\b|M\s*A\s*C\s*R\s*O\s*S/i.test(pageText);
  const hasCont = /\bCONT\b|CONTINUATION/i.test(pageText);
  const hasProcess = /\bPROCESS\b/i.test(pageText);
  const hasStep = /\bSTEP\s*\d+/i.test(pageText);
  const hasHeader = /DIET\s+CHEAT\s+CODES/i.test(pageText);
  const hasRecipeBreakdown =
    /RECIPE\s*PAGE\s*BREAKDOWN/i.test(pageText) || /If you tap on the book title/i.test(pageText);

  const detectedCategory = detectCategoryHint(pageText);

  const isRecipeStart = hasServes && hasIngredients && hasDirections && !hasRecipeBreakdown;
  const isSectionDivider =
    Boolean(detectedCategory) &&
    wordCount <= 12 &&
    !hasHeader &&
    !hasServes &&
    !hasIngredients &&
    !hasDirections &&
    !hasMacros &&
    !hasCont &&
    !hasProcess &&
    !hasStep;

  const isHardBoundary = HARD_BOUNDARY_PATTERNS.some(pattern => pattern.test(pageText));
  const isBoundary = isSectionDivider || isHardBoundary || hasRecipeBreakdown;

  const isContinuation =
    !isRecipeStart &&
    !isBoundary &&
    (hasCont || hasProcess || hasStep || (!hasServes && (hasMacros || hasIngredients || hasDirections)));

  const isImageLike = !isRecipeStart && !isContinuation && !isBoundary && wordCount <= 10;

  const nextSectionHint = isSectionDivider ? detectedCategory : currentSectionHint;
  const sectionHint = detectedCategory || currentSectionHint;

  return {
    meta: {
      page,
      wordCount,
      isRecipeStart,
      isContinuation,
      isImageLike,
      isBoundary,
      sectionHint,
    },
    nextSectionHint,
  };
}

async function extractAllPdfTextPages(): Promise<string[]> {
  const fullText = await runCommand(`pdftotext "${CONFIG.pdfPath}" -`);
  const split = fullText.split('\f');
  const pages: string[] = [''];
  for (let i = 0; i < split.length; i++) {
    if (i === split.length - 1 && split[i].trim() === '') {
      continue;
    }
    pages.push(split[i]);
  }
  return pages;
}

function resolveRecipeRanges(
  pageTexts: string[],
  pageMetas: PageMeta[],
  recipeStartPage: number,
  recipeEndPage: number
): RecipeRange[] {
  const startPages: number[] = [];
  for (let page = recipeStartPage; page <= recipeEndPage; page++) {
    if (pageMetas[page]?.isRecipeStart) {
      startPages.push(page);
    }
  }

  const ranges: RecipeRange[] = [];

  for (let index = 0; index < startPages.length; index++) {
    const startPage = startPages[index];
    const nextStartPage = startPages[index + 1] ?? recipeEndPage + 1;

    const included = new Set<number>([startPage]);

    if (startPage > 1 && pageMetas[startPage - 1]?.isImageLike) {
      included.add(startPage - 1);
    }

    const betweenPages: number[] = [];
    for (let page = startPage + 1; page < nextStartPage; page++) {
      betweenPages.push(page);
      if (pageMetas[page]?.isContinuation) {
        included.add(page);
      }
    }

    const hasContinuation = betweenPages.some(page => pageMetas[page]?.isContinuation);

    if (hasContinuation) {
      const trailingImageRun = new Set<number>();
      for (let page = nextStartPage - 1; page > startPage; page--) {
        if (pageMetas[page]?.isImageLike) {
          trailingImageRun.add(page);
        } else {
          break;
        }
      }

      for (const page of betweenPages) {
        if (pageMetas[page]?.isImageLike && !trailingImageRun.has(page)) {
          included.add(page);
        }
      }
    }

    const pages = Array.from(included).sort((a, b) => a - b);
    const endPage = pages[pages.length - 1];
    const nameHint = extractRecipeNameFromPageText(pageTexts[startPage] || '') || undefined;
    const sectionHint = pageMetas[startPage]?.sectionHint;

    ranges.push({
      startPage,
      endPage,
      pages,
      rangeKey: `${pages[0]}-${pages[pages.length - 1]}`,
      nameHint,
      sectionHint,
    });
  }

  return ranges;
}

async function scanRecipeRanges(force = false): Promise<RangeScanResult> {
  if (cachedRangeScan && !force) {
    return cachedRangeScan;
  }

  const pageTexts = await extractAllPdfTextPages();

  const pageMetas: PageMeta[] = [];
  let sectionHint: string | undefined;

  const totalPages = Math.min(runtimeTotalPages, pageTexts.length - 1);

  for (let page = 1; page <= totalPages; page++) {
    const pageText = pageTexts[page] || '';
    const classified = classifyPage(page, pageText, sectionHint);
    pageMetas[page] = classified.meta;
    sectionHint = classified.nextSectionHint;
  }

  let recipeStartPage = CONFIG.recipeStartPage;
  for (let page = 1; page <= totalPages; page++) {
    if (pageMetas[page]?.isRecipeStart) {
      recipeStartPage = page;
      break;
    }
  }

  let recipeEndPage = totalPages;
  for (let page = recipeStartPage + 1; page <= totalPages; page++) {
    if (/REFERENCE\s*TABLES?/i.test(pageTexts[page] || '')) {
      recipeEndPage = page - 1;
      break;
    }
  }

  const referenceStartPage = Math.min(recipeEndPage + 1, totalPages);
  const recipeRanges = resolveRecipeRanges(pageTexts, pageMetas, recipeStartPage, recipeEndPage);

  runtimeRecipeStartPage = recipeStartPage;
  runtimeRecipeEndPage = recipeEndPage;
  runtimeReferenceRange = {
    start: referenceStartPage,
    end: totalPages,
  };

  cachedRangeScan = {
    pageTexts,
    pageMetas,
    recipeRanges,
    recipeStartPage,
    recipeEndPage,
    referenceStartPage,
    totalPages,
  };

  return cachedRangeScan;
}

function parseRecipeTableEntry(filePath: string, file: string): RecipeTableEntry | null {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);
  const titleLine = lines.find(line => line.startsWith('# '));
  if (!titleLine) {
    return null;
  }

  const headerIndex = lines.findIndex(line => line.includes('| Calories |') && line.includes('Protein'));
  if (headerIndex === -1) {
    return null;
  }

  const dataLine = lines
    .slice(headerIndex + 1)
    .find(line => line.trim().startsWith('|') && !line.includes('---'));

  if (!dataLine) {
    return null;
  }

  const cells = dataLine
    .split('|')
    .map(cell => cell.trim())
    .filter((_, index, array) => index > 0 && index < array.length - 1);

  if (cells.length < 4) {
    return null;
  }

  const calories = cells[0] || 'N/A';
  const fat = cells[1] || 'N/A';
  const carbs = cells[2] || 'N/A';
  const netCarbs = cells.length >= 5 ? (cells[3] || 'N/A') : 'N/A';
  const protein = cells.length >= 5 ? (cells[4] || 'N/A') : (cells[3] || 'N/A');

  const caloriesNum = parseNumericValue(calories);
  const proteinNum = parseNumericValue(protein);
  const carbsNum = parseNumericValue(carbs);
  const netCarbsNum = parseNumericValue(netCarbs);

  const ratio = caloriesNum && caloriesNum > 0 && proteinNum !== null ? proteinNum / caloriesNum : 0;

  const fiber =
    carbsNum !== null && netCarbsNum !== null ? formatNumber(Math.max(0, carbsNum - netCarbsNum)) : 'N/A';

  const filenameWithoutExtension = file.endsWith('.md') ? file.slice(0, -3) : file;
  const categorySlug = filenameWithoutExtension.includes('__')
    ? filenameWithoutExtension.split('__')[0]
    : filenameWithoutExtension;

  return {
    name: titleLine.slice(2).trim(),
    section: titleCaseSlug(categorySlug),
    ratio,
    calories,
    protein,
    fat,
    carbs,
    fiber,
    file,
  };
}

function generateRecipesTable(): number {
  if (!existsSync(CONFIG.recipesDir)) {
    const outputPath = join(CONFIG.outputDir, 'recipes-table.md');
    writeFileSync(outputPath, '# Recipes Table\n\n*0 recipes sorted by protein/calorie ratio (descending)*\n');
    log(`Recipes table saved to ${outputPath}`);
    return 0;
  }

  const recipeFiles = readdirSync(CONFIG.recipesDir)
    .filter(file => file.endsWith('.md'))
    .sort();

  const entries = recipeFiles
    .map(file => parseRecipeTableEntry(join(CONFIG.recipesDir, file), file))
    .filter((entry): entry is RecipeTableEntry => entry !== null);

  entries.sort((a, b) => {
    if (b.ratio !== a.ratio) {
      return b.ratio - a.ratio;
    }
    return a.name.localeCompare(b.name);
  });

  const lines: string[] = [];
  lines.push('# Recipes Table');
  lines.push('');
  lines.push(`*${entries.length} recipes sorted by protein/calorie ratio (descending)*`);
  lines.push('');
  lines.push('| Name | Section | Ratio | Calories | Protein | Fat | Carbs | Fiber | File |');
  lines.push('|------|---------|-------|----------|---------|-----|-------|-------|------|');

  for (const entry of entries) {
    lines.push(
      `| ${escapeTableCell(entry.name)} | ${escapeTableCell(entry.section)} | ${entry.ratio.toFixed(2)} | ${escapeTableCell(entry.calories)} | ${escapeTableCell(entry.protein)} | ${escapeTableCell(entry.fat)} | ${escapeTableCell(entry.carbs)} | ${escapeTableCell(entry.fiber)} | [${entry.file}](recipes/${entry.file}) |`
    );
  }

  lines.push('');

  const outputPath = join(CONFIG.outputDir, 'recipes-table.md');
  writeFileSync(outputPath, lines.join('\n'));
  log(`Recipes table saved to ${outputPath}`);

  return entries.length;
}

function normalizeRecipeForCombinedDoc(content: string): string {
  return content.replace(/\.\.\/images\//g, 'images/').trim();
}

function generateCombinedMarkdown(): number {
  const overviewPath = join(CONFIG.outputDir, 'overview.md');
  const recipeFiles = existsSync(CONFIG.recipesDir)
    ? readdirSync(CONFIG.recipesDir).filter(file => file.endsWith('.md')).sort()
    : [];

  const sections: string[] = [];

  if (existsSync(overviewPath)) {
    sections.push(readFileSync(overviewPath, 'utf-8').trim());
  }

  for (const file of recipeFiles) {
    const recipePath = join(CONFIG.recipesDir, file);
    const recipeContent = readFileSync(recipePath, 'utf-8');
    sections.push(normalizeRecipeForCombinedDoc(recipeContent));
  }

  const outputPath = join(CONFIG.outputDir, 'diet-cheat-codes.md');
  const outputContent = sections.filter(Boolean).join('\n\n---\n\n');
  writeFileSync(outputPath, `${outputContent}\n`);
  log(`Combined markdown saved to ${outputPath}`);

  return recipeFiles.length;
}

async function generateOverview(progress: Progress, force = false): Promise<boolean> {
  if (progress.overviewComplete && !force) {
    log('Overview already complete, skipping...');
    return false;
  }

  log(force ? 'Regenerating overview.md...' : 'Generating overview.md...');

  const sections: string[] = [];
  sections.push('# Diet Cheat Codes - Overview');
  sections.push('');
  sections.push('*A comprehensive guide to making delicious, low-calorie versions of your favorite foods.*');
  sections.push('');

  log('Extracting introduction...');
  const introText = await extractPageText(CONFIG.overviewPages.intro.start, CONFIG.overviewPages.intro.end);
  sections.push('## Introduction');
  sections.push('');
  sections.push(introText.trim());
  sections.push('');

  log('Extracting pantry essentials...');
  const pantryText = await extractPageText(CONFIG.overviewPages.pantry.start, CONFIG.overviewPages.pantry.end);
  sections.push('## Pantry Essentials');
  sections.push('');
  sections.push(pantryText.trim());
  sections.push('');

  log('Extracting kitchen gear...');
  const kitchenText = await extractPageText(CONFIG.overviewPages.kitchen.start, CONFIG.overviewPages.kitchen.end);
  sections.push('## Kitchen Gear');
  sections.push('');
  sections.push(kitchenText.trim());
  sections.push('');

  log('Extracting cooking techniques...');
  const techniquesText = await extractPageText(CONFIG.overviewPages.techniques.start, CONFIG.overviewPages.techniques.end);
  sections.push('## Cooking Techniques & FAQs');
  sections.push('');
  sections.push(techniquesText.trim());
  sections.push('');

  log('Extracting reference tables...');
  const referenceText = await extractPageText(runtimeReferenceRange.start, runtimeReferenceRange.end);
  sections.push('## Reference Tables');
  sections.push('');
  sections.push(referenceText.trim());
  sections.push('');

  const overviewPath = join(CONFIG.outputDir, 'overview.md');
  writeFileSync(overviewPath, sections.join('\n'));

  progress.overviewComplete = true;
  saveProgress(progress);

  log(`Overview saved to ${overviewPath}`);
  return true;
}

async function regenerateAncillaryFiles(progress: Progress): Promise<void> {
  log('Regenerating ancillary files (overview, recipes-table, diet-cheat-codes)...');
  await generateOverview(progress, true);
  generateRecipesTable();
  generateCombinedMarkdown();
}

async function extractPageText(startPage: number, endPage: number = startPage): Promise<string> {
  const cmd = `pdftotext -f ${startPage} -l ${endPage} "${CONFIG.pdfPath}" -`;
  return runCommand(cmd);
}

async function extractPageImage(page: number, outputPath: string): Promise<void> {
  const cmd = `pdftoppm -f ${page} -l ${page} -png -r 150 "${CONFIG.pdfPath}" "${outputPath}"`;
  await runCommand(cmd);
}

async function getPageImageBase64(page: number): Promise<string> {
  const tempPath = join(CONFIG.outputDir, `temp_page_${page}`);
  await extractPageImage(page, tempPath);

  const imagePath = `${tempPath}-${page.toString().padStart(1, '0')}.png`;
  const altPath = `${tempPath}-01.png`;
  const actualPath = existsSync(imagePath) ? imagePath : existsSync(altPath) ? altPath : `${tempPath}-1.png`;

  if (!existsSync(actualPath)) {
    const files = readdirSync(CONFIG.outputDir).filter(file => file.startsWith(`temp_page_${page}`));
    if (files.length > 0) {
      const foundPath = join(CONFIG.outputDir, files[0]);
      const buffer = readFileSync(foundPath);
      unlinkSync(foundPath);
      return buffer.toString('base64');
    }
    throw new Error(`Could not find extracted image for page ${page}`);
  }

  const buffer = readFileSync(actualPath);
  unlinkSync(actualPath);
  return buffer.toString('base64');
}

async function extractRecipeImage(page: number, outputFilename: string): Promise<boolean> {
  const outputPath = join(CONFIG.imagesDir, outputFilename);

  if (existsSync(outputPath)) {
    return true;
  }

  const tempPrefix = `temp_photo_${page}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const tempBase = join(CONFIG.outputDir, tempPrefix);

  try {
    const cmd = `pdftoppm -f ${page} -l ${page} -jpeg -r 220 "${CONFIG.pdfPath}" "${tempBase}"`;
    await runCommand(cmd);

    const files = readdirSync(CONFIG.outputDir).filter(file => file.startsWith(tempPrefix));
    if (files.length === 0) {
      return false;
    }

    const tempFile = join(CONFIG.outputDir, files[0]);
    const buffer = readFileSync(tempFile);
    writeFileSync(outputPath, buffer);
    unlinkSync(tempFile);
    return true;
  } catch (error: any) {
    logError(`Failed to extract image for page ${page}: ${error.message}`);
    return false;
  }
}

const RECIPE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'The recipe name exactly as shown' },
    category: {
      type: 'string',
      description: 'The category shown at bottom of recipe page (e.g., Breakfast Bliss)',
    },
    serves: { type: 'string', description: 'Number of servings' },
    prepTime: { type: 'string', description: 'Prep time (e.g., 5 MINS)' },
    cookTime: { type: 'string', description: 'Cook time (e.g., 10 MINS)' },
    macros: {
      type: 'object',
      properties: {
        calories: { type: 'number' },
        fat: { type: 'string' },
        carbs: { type: 'string' },
        netCarbs: { type: 'string' },
        protein: { type: 'string' },
      },
      required: ['calories', 'fat', 'carbs', 'protein'],
    },
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          section: {
            type: 'string',
            description: 'Section name like WET, DRY, MAIN, or empty string if no sections',
          },
          items: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of ingredients with amounts',
          },
        },
        required: ['section', 'items'],
      },
    },
    directions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Numbered steps as strings without number prefix',
    },
    tips: { type: 'string', description: 'Any TIP mentioned, empty string if none' },
    notes: { type: 'string', description: 'Any NOTE mentioned, empty string if none' },
  },
  required: ['name', 'category', 'serves', 'prepTime', 'cookTime', 'macros', 'ingredients', 'directions'],
};

async function callGeminiWithParts(parts: any[], schema: object, retries: number = 3): Promise<any> {
  if (!CONFIG.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.geminiModel}:generateContent?key=${CONFIG.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              response_mime_type: 'application/json',
              response_schema: schema,
            },
          }),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 429) {
          const waitTime = Math.pow(2, attempt) * 1000;
          log(`Rate limited, waiting ${waitTime}ms before retry ${attempt}/${retries}`);
          await Bun.sleep(waitTime);
          continue;
        }
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
        throw new Error('Invalid response structure from Gemini');
      }

      return JSON.parse(data.candidates[0].content.parts[0].text);
    } catch (error: any) {
      if (attempt === retries) {
        throw error;
      }
      const waitTime = Math.pow(2, attempt) * 500;
      log(`API call failed, retrying in ${waitTime}ms... (${error.message})`);
      await Bun.sleep(waitTime);
    }
  }

  throw new Error('Failed to call Gemini API');
}

async function parseMultiPageRecipe(imageBuffers: string[], pageNumbers: number[]): Promise<Recipe | null> {
  const parts: any[] = [
    {
      text: `Extract the recipe information from these ${imageBuffers.length} cookbook pages (pages ${pageNumbers.join(', ')}).

These pages together contain ONE recipe. Look across ALL pages to find:
- Recipe name
- Category
- Serves/Prep/Cook times
- MACROS (calories, fat, carbs, net carbs, protein)
- All ingredients
- All directions
- Any tips or notes

If one page is a process/addendum page with only step photos, still include that page's context and keep the recipe aligned to the main recipe page.`,
    },
  ];

  for (const base64 of imageBuffers) {
    parts.push({
      inline_data: {
        mime_type: 'image/png',
        data: base64,
      },
    });
  }

  try {
    const result = await callGeminiWithParts(parts, RECIPE_SCHEMA);
    return result as Recipe;
  } catch (error: any) {
    logError(`Multi-page parse failed: ${error.message}`);
    return null;
  }
}

function generateRecipeMarkdown(recipe: Recipe, imageFilenames: string[], sourcePages: number[]): string {
  const lines: string[] = [];

  lines.push(`# ${recipe.name}`);
  lines.push('');
  lines.push(`**Serves:** ${recipe.serves} | **Prep:** ${recipe.prepTime} | **Cook:** ${recipe.cookTime}`);
  lines.push('');

  lines.push('## Macros');
  lines.push('');
  lines.push('| Calories | Fat | Carbs | Net Carbs | Protein |');
  lines.push('|----------|-----|-------|-----------|---------|');
  lines.push(
    `| ${recipe.macros.calories} | ${cleanMacroValue(recipe.macros.fat)} | ${cleanMacroValue(recipe.macros.carbs)} | ${cleanMacroValue(recipe.macros.netCarbs) || 'N/A'} | ${cleanMacroValue(recipe.macros.protein)} |`
  );
  lines.push('');

  lines.push('## Ingredients');
  lines.push('');

  for (const section of recipe.ingredients) {
    if (section.section && section.section.trim() !== '') {
      lines.push(`### ${section.section}`);
      lines.push('');
    }
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  lines.push('## Directions');
  lines.push('');
  recipe.directions.forEach((step, index) => {
    lines.push(`${index + 1}. ${step}`);
  });
  lines.push('');

  if (recipe.tips && recipe.tips.trim() !== '') {
    lines.push('## Tips');
    lines.push('');
    lines.push(recipe.tips);
    lines.push('');
  }

  if (recipe.notes && recipe.notes.trim() !== '') {
    lines.push('## Notes');
    lines.push('');
    lines.push(recipe.notes);
    lines.push('');
  }

  if (imageFilenames.length > 0) {
    lines.push(`![${recipe.name}](../images/${imageFilenames[0]})`);
    lines.push('');
  }

  if (imageFilenames.length > 1) {
    lines.push('## Additional Recipe Pages');
    lines.push('');
    for (let index = 1; index < imageFilenames.length; index++) {
      const sourcePage = sourcePages[index] || sourcePages[sourcePages.length - 1];
      lines.push(`![${recipe.name} - page ${sourcePage}](../images/${imageFilenames[index]})`);
      lines.push('');
    }
  }

  lines.push('## Source Pages');
  lines.push('');
  lines.push(sourcePages.join(', '));
  lines.push('');

  return lines.join('\n');
}

function getRecipeNameSlugFromIdentifier(identifier: string): string | null {
  const normalizedIdentifier = identifier.endsWith('.md') ? identifier.slice(0, -3) : identifier;
  if (!normalizedIdentifier) {
    return null;
  }
  const parts = normalizedIdentifier.split('__');
  const nameSlug = parts.length > 1 ? parts.slice(1).join('__') : normalizedIdentifier;
  return nameSlug.trim() || null;
}

function createFilenameResolver(): {
  resolve: (nameSlug: string, categorySlug: string, startPage: number) => string;
} {
  const existingFiles = existsSync(CONFIG.recipesDir)
    ? readdirSync(CONFIG.recipesDir).filter(file => file.endsWith('.md')).map(file => file.slice(0, -3))
    : [];

  const byNameSlug = new Map<string, string[]>();
  for (const base of existingFiles) {
    const nameSlug = getRecipeNameSlugFromIdentifier(base);
    if (!nameSlug) {
      continue;
    }
    const existing = byNameSlug.get(nameSlug) || [];
    existing.push(base);
    byNameSlug.set(nameSlug, existing);
  }

  const used = new Set<string>();

  const resolve = (nameSlug: string, categorySlug: string, startPage: number): string => {
    const candidates = [...(byNameSlug.get(nameSlug) || [])].sort();
    const prefixPriority = LEGACY_PREFIX_PRIORITY[categorySlug] || [categorySlug, 'uncategorized'];

    const scoreCandidate = (candidate: string): number => {
      const prefix = candidate.includes('__') ? candidate.split('__')[0] : candidate;
      const index = prefixPriority.indexOf(prefix);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };

    const sortedCandidates = candidates.sort((a, b) => {
      const scoreA = scoreCandidate(a);
      const scoreB = scoreCandidate(b);
      if (scoreA !== scoreB) {
        return scoreA - scoreB;
      }
      return a.localeCompare(b);
    });

    for (const candidate of sortedCandidates) {
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }

    const preferredPrefix = prefixPriority[0] || categorySlug || 'uncategorized';
    const base = `${preferredPrefix}__${nameSlug}`;
    if (!used.has(base)) {
      used.add(base);
      return base;
    }

    const withSuffix = `${preferredPrefix}__${nameSlug}-${startPage}`;
    used.add(withSuffix);
    return withSuffix;
  };

  return { resolve };
}

function trackRecipe(progress: Progress, filename: string): void {
  if (!progress.recipesProcessed.includes(filename)) {
    progress.recipesProcessed.push(filename);
  }
  progress.totalRecipes = Array.from(new Set(progress.recipesProcessed)).length;
}

function markRangeProcessed(progress: Progress, range: RecipeRange): void {
  if (!progress.rangeKeysProcessed.includes(range.rangeKey)) {
    progress.rangeKeysProcessed.push(range.rangeKey);
  }

  for (const page of range.pages) {
    if (!progress.pagesProcessed.includes(page)) {
      progress.pagesProcessed.push(page);
    }
  }

  progress.currentPage = Math.max(progress.currentPage, range.endPage + 1);
}

async function processRecipeRange(
  range: RecipeRange,
  progress: Progress,
  pageMetas: PageMeta[],
  resolver: { resolve: (nameSlug: string, categorySlug: string, startPage: number) => string }
): Promise<{ status: 'processed' | 'failed'; output?: RecipeOutput }> {
  try {
    log(`Processing range ${range.pages.join(', ')}...`);

    const imageBuffers: string[] = [];
    for (const page of range.pages) {
      const base64 = await getPageImageBase64(page);
      imageBuffers.push(base64);
    }

    const recipe = await parseMultiPageRecipe(imageBuffers, range.pages);
    if (!recipe || !recipe.name || !recipe.ingredients || recipe.ingredients.length === 0) {
      throw new Error('Parsed recipe missing required fields');
    }

    const nameSlug = slugify(recipe.name || range.nameHint || `recipe-${range.startPage}`);
    const categoryFromRecipe = recipe.category ? getCategorySlug(recipe.category) : undefined;
    const categoryFromSection = range.sectionHint;
    const categorySlug =
      categoryFromSection || categoryFromRecipe || (pageMetas[range.startPage]?.sectionHint || 'uncategorized');

    const filename = resolver.resolve(nameSlug, categorySlug, range.startPage);

    const imageFilenames: string[] = [];

    const orderedPages = [...range.pages].sort((a, b) => a - b);
    const primaryCandidate = orderedPages.find(page => pageMetas[page]?.isImageLike) || orderedPages[0];
    const finalImageOrder = [
      primaryCandidate,
      ...orderedPages.filter(page => page !== primaryCandidate),
    ];

    for (const page of finalImageOrder) {
      const imageFilename = `${filename}__p${page}.jpg`;
      const hasImage = await extractRecipeImage(page, imageFilename);
      if (hasImage) {
        imageFilenames.push(imageFilename);
      }
    }

    const markdown = generateRecipeMarkdown(recipe, imageFilenames, finalImageOrder);
    const mdPath = join(CONFIG.recipesDir, `${filename}.md`);
    writeFileSync(mdPath, markdown);

    trackRecipe(progress, filename);
    markRangeProcessed(progress, range);
    saveProgress(progress);

    log(`  Saved: ${filename}.md`);

    return {
      status: 'processed',
      output: {
        filename,
        imageFilenames,
      },
    };
  } catch (error: any) {
    logError(`Failed to process range ${range.rangeKey}: ${error.message}`);
    progress.errors.push({
      page: range.startPage,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
    saveProgress(progress);
    return { status: 'failed' };
  }
}

async function processAllRecipeRanges(
  progress: Progress,
  ranges: RecipeRange[],
  pageMetas: PageMeta[],
  fullRebuild: boolean
): Promise<ProcessingStats> {
  log('Starting recipe processing...');
  log(`Current progress: ${progress.recipesProcessed.length} recipes tracked`);

  const resolver = createFilenameResolver();

  const alreadyProcessed = new Set(progress.rangeKeysProcessed);
  const rangesToProcess = fullRebuild
    ? ranges
    : ranges.filter(range => !alreadyProcessed.has(range.rangeKey));

  log(
    `Scanning recipe ranges ${runtimeRecipeStartPage}-${runtimeRecipeEndPage}` +
      ` (${ranges.length} total ranges, ${rangesToProcess.length} queued)`
  );

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  const keepRecipeFiles = new Set<string>();
  const keepImageFiles = new Set<string>();

  for (const range of rangesToProcess) {
    const result = await processRecipeRange(range, progress, pageMetas, resolver);
    if (result.status === 'processed') {
      processed++;
      if (result.output) {
        keepRecipeFiles.add(result.output.filename);
        for (const imageFilename of result.output.imageFilenames) {
          keepImageFiles.add(imageFilename);
        }
      }
    } else {
      failed++;
    }

    if ((processed + failed) % 10 === 0) {
      log(
        `Progress: ${processed} processed, ${failed} failed, ${rangesToProcess.length - processed - failed} remaining`
      );
    }
  }

  if (!fullRebuild) {
    skipped = ranges.length - rangesToProcess.length;
  }

  log(`Recipe processing complete: ${processed} processed, ${skipped} skipped, ${failed} failed`);

  return {
    processed,
    skipped,
    failed,
    keepRecipeFiles,
    keepImageFiles,
  };
}

function cleanupUnmatchedOutputs(keepRecipeFiles: Set<string>, keepImageFiles: Set<string>): void {
  let removedRecipeCount = 0;
  let removedImageCount = 0;

  if (existsSync(CONFIG.recipesDir)) {
    const recipeFiles = readdirSync(CONFIG.recipesDir).filter(file => file.endsWith('.md'));
    for (const file of recipeFiles) {
      const base = file.slice(0, -3);
      if (!keepRecipeFiles.has(base)) {
        unlinkSync(join(CONFIG.recipesDir, file));
        removedRecipeCount++;
      }
    }
  }

  if (existsSync(CONFIG.imagesDir)) {
    const imageFiles = readdirSync(CONFIG.imagesDir).filter(file => /\.(jpg|jpeg|png)$/i.test(file));
    for (const file of imageFiles) {
      if (!keepImageFiles.has(file)) {
        unlinkSync(join(CONFIG.imagesDir, file));
        removedImageCount++;
      }
    }
  }

  log(`Cleanup complete: removed ${removedRecipeCount} stale recipe files and ${removedImageCount} stale images`);
}

async function reparseRecipe(pages: number[], outputName?: string): Promise<boolean> {
  log(`Re-parsing recipe from pages: ${pages.join(', ')}`);

  if (pages.length === 0) {
    logError('No pages specified');
    return false;
  }

  const sortedPages = [...pages].sort((a, b) => a - b);
  const imageBuffers: string[] = [];

  for (const page of sortedPages) {
    log(`  Extracting page ${page}...`);
    const base64 = await getPageImageBase64(page);
    imageBuffers.push(base64);
  }

  const recipe = await parseMultiPageRecipe(imageBuffers, sortedPages);
  if (!recipe) {
    logError('Failed to parse recipe from provided pages');
    return false;
  }

  log(`  Parsed: ${recipe.name} (${recipe.category})`);

  const nameSlug = slugify(recipe.name);
  const categorySlug = getCategorySlug(recipe.category || 'uncategorized');
  const preferredPrefix = (LEGACY_PREFIX_PRIORITY[categorySlug] || [categorySlug])[0];
  const filename = outputName || `${preferredPrefix}__${nameSlug}`;

  const imageFilenames: string[] = [];
  for (const page of sortedPages) {
    const imageFilename = `${filename}__p${page}.jpg`;
    const hasImage = await extractRecipeImage(page, imageFilename);
    if (hasImage) {
      imageFilenames.push(imageFilename);
    }
  }

  const markdown = generateRecipeMarkdown(recipe, imageFilenames, sortedPages);
  const mdPath = join(CONFIG.recipesDir, `${filename}.md`);
  writeFileSync(mdPath, markdown);

  const progress = loadProgress();
  trackRecipe(progress, filename);
  saveProgress(progress);

  log(`  Saved: ${filename}.md`);
  return true;
}

function printUsage(): void {
  console.log(`
Diet Cheat Codes PDF Parser

Usage:
  bun run parse.ts <pdf-path>                         Process recipes
  bun run parse.ts <pdf-path> --output-dir <dir>      Process recipes to custom output directory
  bun run parse.ts <pdf-path> --scan-ranges           Print detected recipe ranges only
  bun run parse.ts <pdf-path> --full-rebuild          Rebuild all ranges and hard-delete stale outputs
  bun run parse.ts <pdf-path> --reparse <pages>       Re-parse specific pages
  bun run parse.ts --help                             Show this help

Examples:
  bun run parse.ts "~/Downloads/Diet Cheat Codes 21826.pdf" --scan-ranges
  bun run parse.ts "~/Downloads/Diet Cheat Codes 21826.pdf" --full-rebuild
  bun run parse.ts "~/Downloads/Diet Cheat Codes 21826.pdf" --reparse 397,398,399,400

Options:
  <pdf-path>           Path to the Diet Cheat Codes PDF file
  --output-dir <dir>   Output directory (default: current working directory)
  --scan-ranges        Scan and print recipe ranges without Gemini parsing
  --full-rebuild       Rebuild all detected recipe ranges and delete stale files
  --reparse <pages>    Comma-separated list of page numbers to re-parse
  --name <filename>    Output filename (without .md extension)
  --help               Show this help message
`);
}

function printRangeScan(scan: RangeScanResult): void {
  console.log(`Detected ${scan.recipeRanges.length} recipe ranges`);
  console.log(`Recipe region: ${scan.recipeStartPage}-${scan.recipeEndPage}`);
  console.log(`Reference starts at: ${scan.referenceStartPage}`);
  console.log('');
  for (const range of scan.recipeRanges) {
    const name = range.nameHint || '(unknown)';
    const section = range.sectionHint || 'unknown';
    console.log(
      `${range.startPage}\t${range.pages.join(',')}\t${name}\tsection=${section}`
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }

  const outputDirIndex = args.indexOf('--output-dir');
  if (outputDirIndex !== -1 && !args[outputDirIndex + 1]) {
    logError('--output-dir requires a directory path');
    process.exit(1);
  }

  const outputDirArg = outputDirIndex !== -1 ? args[outputDirIndex + 1] : process.cwd();
  configureOutputPaths(outputDirArg);

  const pdfPath = args.find((arg, index) => {
    if (arg.startsWith('-')) {
      return false;
    }
    const previousArg = args[index - 1];
    return previousArg !== '--reparse' && previousArg !== '--name' && previousArg !== '--output-dir';
  });

  if (!pdfPath) {
    console.log(`PDF path is required. Download it from "${PDF_DOWNLOAD_URL}"`);
    process.exit(1);
  }

  CONFIG.pdfPath = expandHomePath(pdfPath);

  await initializePdfLayout();

  mkdirSync(CONFIG.outputDir, { recursive: true });
  mkdirSync(CONFIG.recipesDir, { recursive: true });
  mkdirSync(CONFIG.imagesDir, { recursive: true });

  const scanRangesMode = args.includes('--scan-ranges');
  const fullRebuildMode = args.includes('--full-rebuild');

  const reparseIndex = args.indexOf('--reparse');
  if (reparseIndex !== -1) {
    const pagesArg = args[reparseIndex + 1];
    if (!pagesArg) {
      logError('--reparse requires page numbers (e.g., --reparse 47,48)');
      process.exit(1);
    }

    const pages = pagesArg
      .split(',')
      .map(token => parseInt(token.trim(), 10))
      .filter(page => !Number.isNaN(page));

    if (pages.length === 0) {
      logError('Invalid page numbers');
      process.exit(1);
    }

    const nameIndex = args.indexOf('--name');
    const outputName = nameIndex !== -1 ? args[nameIndex + 1] : undefined;

    const didWork = await reparseRecipe(pages, outputName);
    if (didWork) {
      const progress = loadProgress();
      await regenerateAncillaryFiles(progress);
    } else {
      log('No work done, skipping ancillary file regeneration.');
    }
    return;
  }

  const scan = await scanRecipeRanges();

  if (scanRangesMode) {
    printRangeScan(scan);
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Diet Cheat Codes PDF Parser');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Output directory: ${CONFIG.outputDir}`);
  console.log(`  PDF page count: ${scan.totalPages}`);
  console.log(`  Recipe range: ${scan.recipeStartPage}-${scan.recipeEndPage}`);
  console.log(`  Detected recipe starts: ${scan.recipeRanges.length}`);
  console.log('');

  const progress = fullRebuildMode ? createDefaultProgress() : loadProgress();
  if (fullRebuildMode) {
    saveProgress(progress);
  }

  log(`Loaded progress: ${progress.recipesProcessed.length} recipes already tracked`);

  process.on('SIGINT', () => {
    log('Received SIGINT, saving progress...');
    saveProgress(progress);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('Received SIGTERM, saving progress...');
    saveProgress(progress);
    process.exit(0);
  });

  try {
    const overviewGenerated = await generateOverview(progress, fullRebuildMode);
    const processingStats = await processAllRecipeRanges(
      progress,
      scan.recipeRanges,
      scan.pageMetas,
      fullRebuildMode
    );

    if (fullRebuildMode) {
      if (processingStats.failed > 0) {
        throw new Error(`Full rebuild had ${processingStats.failed} failed ranges; skipping cleanup`);
      }
      cleanupUnmatchedOutputs(processingStats.keepRecipeFiles, processingStats.keepImageFiles);
    }

    const didWork = overviewGenerated || processingStats.processed > 0 || fullRebuildMode;
    if (didWork) {
      await regenerateAncillaryFiles(progress);
    } else {
      log('No work done, skipping ancillary file regeneration.');
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  Processing Complete!');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(`  Total recipes tracked: ${progress.totalRecipes}`);
    console.log(`  Range failures: ${processingStats.failed}`);
    console.log(`  Output directory: ${CONFIG.outputDir}`);
    console.log('═══════════════════════════════════════════════════════════════');
  } catch (error: any) {
    logError(`Fatal error: ${error.message}`);
    saveProgress(progress);
    process.exit(1);
  }
}

main();
