#!/usr/bin/env bun
/**
 * Diet Cheat Codes PDF Parser
 *
 * Parses the cookbook PDF into structured markdown files using Gemini 2.5 Flash.
 * Supports resuming from where it left off via progress.json.
 *
 * Usage: bun run parse.ts <pdf-path>
 */

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  pdfPath: '',
  outputDir: process.cwd(),
  recipesDir: join(process.cwd(), 'recipes'),
  imagesDir: join(process.cwd(), 'images'),
  progressFile: join(process.cwd(), 'progress.json'),
  geminiApiKey: process.env.GEMINI_API_KEY!,
  geminiModel: "gemini-2.5-flash",
  totalPages: 475,

  // Page ranges for different sections
  overviewPages: {
    intro: { start: 8, end: 15 },      // Introduction, disclaimers
    pantry: { start: 16, end: 19 },    // Pantry Essentials
    kitchen: { start: 20, end: 25 },   // Kitchen Gear
    techniques: { start: 26, end: 44 }, // Cooking Techniques, FAQs, etc.
    reference: { start: 461, end: 474 } // Reference Tables
  },

  // Recipe section starts around page 45
  recipeStartPage: 45,
  recipeEndPage: 460,
  trailingNonRecipePages: 15,
};

const PDF_DOWNLOAD_URL = 'https://dietcheatcodes.com/d/confirm_email/7a94da0fdbc3593a523a9ac8d5ab1658be59efcd';

// Category name mappings
const CATEGORY_MAP: Record<string, string> = {
  "breakfast bliss": "breakfast-bliss",
  "midday munchies": "midday-munchies",
  "dinner is served": "dinner-is-served",
  "sweet treats": "sweet-treats",
  "ice cream pints": "ice-cream-pints",
  "fruit sorbets": "fruit-sorbets",
  "cookie dough": "cookie-dough",
  "shareables": "shareables",
  "let's get saucy": "lets-get-saucy",
  "doughlicious": "doughlicious",
  "prep school": "prep-school",
  "blender ice cream": "blender-ice-cream",
  "protein ice cream": "protein-ice-cream",
};

// ============================================================================
// Types
// ============================================================================

interface Progress {
  lastUpdated: string;
  overviewComplete: boolean;
  recipesProcessed: string[];
  pagesProcessed: number[];
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

interface PageAnalysis {
  isRecipePage: boolean;
  isPhotoPage: boolean;
  recipeName?: string;
  category?: string;
  pageNumber: number;
}

// ============================================================================
// Utility Functions
// ============================================================================

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[''"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function cleanMacroValue(value: string): string {
  const trimmed = String(value).trim();
  if (trimmed === "N/A" || trimmed === "" || trimmed === "0") {
    return trimmed;
  }
  // Extract just the number, removing G, g, and any text like FAT, CARBS, PROTEIN
  const match = trimmed.match(/^(\d+(?:\.\d+)?)/);
  return match ? match[1] : trimmed;
}

function getCategorySlug(category: string): string {
  const normalized = category.toLowerCase().trim();
  return CATEGORY_MAP[normalized] || slugify(category);
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
    currentPage: CONFIG.recipeStartPage,
    totalRecipes: 0,
    errors: [],
  };
}

function normalizeProgress(progress: Progress): Progress {
  const recipesProcessed = Array.from(new Set(progress.recipesProcessed));
  const pagesProcessed = Array.from(new Set(progress.pagesProcessed)).sort((a, b) => a - b);
  const currentPage = progress.currentPage && progress.currentPage > 0 ? progress.currentPage : CONFIG.recipeStartPage;
  return {
    ...progress,
    recipesProcessed,
    pagesProcessed,
    currentPage,
    totalRecipes: recipesProcessed.length,
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

let runtimeRecipeEndPage = CONFIG.recipeEndPage;
let runtimeReferenceRange = { ...CONFIG.overviewPages.reference };

async function initializePdfLayout(): Promise<void> {
  const info = await runCommand(`pdfinfo "${CONFIG.pdfPath}"`);
  const pagesMatch = info.match(/Pages:\s+(\d+)/);

  if (!pagesMatch) {
    log('Could not read PDF page count from pdfinfo, using configured page ranges');
    runtimeRecipeEndPage = CONFIG.recipeEndPage;
    runtimeReferenceRange = { ...CONFIG.overviewPages.reference };
    return;
  }

  const totalPages = parseInt(pagesMatch[1], 10);
  const computedRecipeEndPage = totalPages - CONFIG.trailingNonRecipePages;

  runtimeRecipeEndPage = Math.max(CONFIG.recipeStartPage, computedRecipeEndPage);
  runtimeReferenceRange = {
    start: runtimeRecipeEndPage + 1,
    end: Math.max(runtimeRecipeEndPage + 1, totalPages - 1),
  };
}

function loadProgress(): Progress {
  return readProgressFile(CONFIG.progressFile) || createDefaultProgress();
}

function saveProgress(progress: Progress): void {
  progress.lastUpdated = new Date().toISOString();
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

// ============================================================================
// PDF Processing Functions
// ============================================================================

async function extractPageText(startPage: number, endPage: number = startPage): Promise<string> {
  const cmd = `pdftotext -f ${startPage} -l ${endPage} "${CONFIG.pdfPath}" -`;
  return runCommand(cmd);
}

async function extractPageImage(page: number, outputPath: string): Promise<void> {
  // Convert PDF page to PNG image for Gemini
  const cmd = `pdftoppm -f ${page} -l ${page} -png -r 150 "${CONFIG.pdfPath}" "${outputPath}"`;
  await runCommand(cmd);
}

async function extractAllImages(): Promise<void> {
  log("Extracting all images from PDF (this may take a while)...");
  const tempDir = join(CONFIG.outputDir, "temp_images");
  mkdirSync(tempDir, { recursive: true });

  // Extract all images from PDF
  const cmd = `pdfimages -j "${CONFIG.pdfPath}" "${tempDir}/img"`;
  await runCommand(cmd);

  log(`Images extracted to ${tempDir}`);
}

async function getPageImageBase64(page: number): Promise<string> {
  const tempPath = join(CONFIG.outputDir, `temp_page_${page}`);
  await extractPageImage(page, tempPath);

  // pdftoppm adds suffix like -1.png
  const imagePath = `${tempPath}-${page.toString().padStart(1, '0')}.png`;
  const altPath = `${tempPath}-01.png`;
  const actualPath = existsSync(imagePath) ? imagePath : existsSync(altPath) ? altPath : `${tempPath}-1.png`;

  if (!existsSync(actualPath)) {
    // Try to find any matching file
    const files = readdirSync(CONFIG.outputDir).filter(f => f.startsWith(`temp_page_${page}`));
    if (files.length > 0) {
      const foundPath = join(CONFIG.outputDir, files[0]);
      const buffer = readFileSync(foundPath);
      unlinkSync(foundPath);
      return buffer.toString("base64");
    }
    throw new Error(`Could not find extracted image for page ${page}`);
  }

  const buffer = readFileSync(actualPath);
  unlinkSync(actualPath); // Clean up temp file
  return buffer.toString("base64");
}

// ============================================================================
// Gemini API Integration
// ============================================================================

const RECIPE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "The recipe name exactly as shown" },
    category: { type: "string", description: "The category shown at bottom of page (e.g., 'Breakfast Bliss', 'Dinner is Served')" },
    serves: { type: "string", description: "Number of servings" },
    prepTime: { type: "string", description: "Prep time (e.g., '5 MINS')" },
    cookTime: { type: "string", description: "Cook time (e.g., '10 MINS')" },
    macros: {
      type: "object",
      properties: {
        calories: { type: "number" },
        fat: { type: "string" },
        carbs: { type: "string" },
        netCarbs: { type: "string" },
        protein: { type: "string" }
      },
      required: ["calories", "fat", "carbs", "protein"]
    },
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          section: { type: "string", description: "Section name like 'WET', 'DRY', 'MAIN', or empty string if no sections" },
          items: {
            type: "array",
            items: { type: "string" },
            description: "List of ingredients with amounts"
          }
        },
        required: ["section", "items"]
      }
    },
    directions: {
      type: "array",
      items: { type: "string" },
      description: "Numbered steps as strings without the number prefix"
    },
    tips: { type: "string", description: "Any TIP mentioned, empty string if none" },
    notes: { type: "string", description: "Any NOTE mentioned, empty string if none" }
  },
  required: ["name", "category", "serves", "prepTime", "cookTime", "macros", "ingredients", "directions"]
};

const PAGE_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    isRecipePage: { type: "boolean", description: "True if this page contains a recipe with ingredients and directions" },
    isPhotoPage: { type: "boolean", description: "True if this is primarily a photo page (full-page image)" },
    isSectionDivider: { type: "boolean", description: "True if this is a section divider page (like 'BREAKFAST BLISS' title page)" },
    recipeName: { type: "string", description: "Name of recipe if visible on this page" },
    category: { type: "string", description: "Category name if visible (e.g., 'Breakfast Bliss')" },
    pageType: { type: "string", description: "One of: recipe, photo, section_divider, table_of_contents, intro, reference_table, other" }
  },
  required: ["isRecipePage", "isPhotoPage", "pageType"]
};

async function callGeminiAPI(
  prompt: string,
  imageBase64: string | null,
  schema: object,
  retries: number = 3
): Promise<any> {
  const parts: any[] = [{ text: prompt }];

  if (imageBase64) {
    parts.push({
      inline_data: {
        mime_type: "image/png",
        data: imageBase64
      }
    });
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.geminiModel}:generateContent?key=${CONFIG.geminiApiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              response_mime_type: "application/json",
              response_schema: schema
            }
          })
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 429) {
          // Rate limited - wait and retry
          const waitTime = Math.pow(2, attempt) * 1000;
          log(`Rate limited, waiting ${waitTime}ms before retry ${attempt}/${retries}`);
          await Bun.sleep(waitTime);
          continue;
        }
        throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
        throw new Error("Invalid response structure from Gemini");
      }

      const text = data.candidates[0].content.parts[0].text;
      return JSON.parse(text);
    } catch (error: any) {
      if (attempt === retries) {
        throw error;
      }
      const waitTime = Math.pow(2, attempt) * 500;
      log(`API call failed, retrying in ${waitTime}ms... (${error.message})`);
      await Bun.sleep(waitTime);
    }
  }
}

async function analyzePage(page: number): Promise<PageAnalysis> {
  const imageBase64 = await getPageImageBase64(page);

  const prompt = `Analyze this cookbook page and determine what type of content it contains.
Look for:
- Is this a recipe page with ingredients, directions, and macros?
- Is this a full-page photo (usually the page before a recipe)?
- Is this a section divider (large category title like "BREAKFAST BLISS")?
- What category does this belong to (look at footer or header)?

Return accurate JSON based on what you see.`;

  const result = await callGeminiAPI(prompt, imageBase64, PAGE_ANALYSIS_SCHEMA);
  return {
    ...result,
    pageNumber: page
  };
}

async function parseRecipePage(page: number): Promise<Recipe | null> {
  const imageBase64 = await getPageImageBase64(page);

  const prompt = `Extract all recipe information from this cookbook page into structured JSON.

IMPORTANT:
- Extract the recipe name EXACTLY as shown (preserve capitalization)
- Include ALL ingredients with their exact measurements
- Include ALL directions steps
- Look for the category at the bottom of the page (e.g., "Breakfast Bliss", "Dinner is Served")
- Extract the MACROS box values (calories, fat, carbs, net carbs, protein)
- If ingredients are divided into sections (WET, DRY, etc.), preserve those sections
- Include any TIP or NOTE sections
- For serves/prep/cook, include just the value (e.g., "1", "5 MINS", "10 MINS")

Be precise and thorough. Do not skip any information.`;

  try {
    const result = await callGeminiAPI(prompt, imageBase64, RECIPE_SCHEMA);
    return result as Recipe;
  } catch (error: any) {
    logError(`Failed to parse recipe on page ${page}: ${error.message}`);
    return null;
  }
}

// ============================================================================
// Markdown Generation
// ============================================================================

function generateRecipeMarkdown(recipe: Recipe, imageFilename: string | null): string {
  const lines: string[] = [];

  // Title
  lines.push(`# ${recipe.name}`);
  lines.push("");

  // Meta info
  lines.push(`**Serves:** ${recipe.serves} | **Prep:** ${recipe.prepTime} | **Cook:** ${recipe.cookTime}`);
  lines.push("");

  // Macros table
  lines.push("## Macros");
  lines.push("");
  lines.push("| Calories | Fat | Carbs | Net Carbs | Protein |");
  lines.push("|----------|-----|-------|-----------|---------|");
  lines.push(`| ${recipe.macros.calories} | ${cleanMacroValue(recipe.macros.fat)} | ${cleanMacroValue(recipe.macros.carbs)} | ${cleanMacroValue(recipe.macros.netCarbs) || "N/A"} | ${cleanMacroValue(recipe.macros.protein)} |`);
  lines.push("");

  // Ingredients
  lines.push("## Ingredients");
  lines.push("");

  for (const section of recipe.ingredients) {
    if (section.section && section.section.trim() !== "") {
      lines.push(`### ${section.section}`);
      lines.push("");
    }
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  // Directions
  lines.push("## Directions");
  lines.push("");

  recipe.directions.forEach((step, index) => {
    lines.push(`${index + 1}. ${step}`);
  });
  lines.push("");

  // Tips
  if (recipe.tips && recipe.tips.trim() !== "") {
    lines.push("## Tips");
    lines.push("");
    lines.push(recipe.tips);
    lines.push("");
  }

  // Notes
  if (recipe.notes && recipe.notes.trim() !== "") {
    lines.push("## Notes");
    lines.push("");
    lines.push(recipe.notes);
    lines.push("");
  }

  // Image
  if (imageFilename) {
    lines.push(`![${recipe.name}](../images/${imageFilename})`);
    lines.push("");
  }

  return lines.join("\n");
}

async function generateOverview(progress: Progress): Promise<void> {
  if (progress.overviewComplete) {
    log("Overview already complete, skipping...");
    return;
  }

  log("Generating overview.md...");

  const sections: string[] = [];
  sections.push("# Diet Cheat Codes - Overview");
  sections.push("");
  sections.push("*A comprehensive guide to making delicious, low-calorie versions of your favorite foods.*");
  sections.push("");

  // Extract intro section
  log("Extracting introduction...");
  const introText = await extractPageText(CONFIG.overviewPages.intro.start, CONFIG.overviewPages.intro.end);
  sections.push("## Introduction");
  sections.push("");
  sections.push(introText.trim());
  sections.push("");

  // Extract pantry essentials
  log("Extracting pantry essentials...");
  const pantryText = await extractPageText(CONFIG.overviewPages.pantry.start, CONFIG.overviewPages.pantry.end);
  sections.push("## Pantry Essentials");
  sections.push("");
  sections.push(pantryText.trim());
  sections.push("");

  // Extract kitchen gear
  log("Extracting kitchen gear...");
  const kitchenText = await extractPageText(CONFIG.overviewPages.kitchen.start, CONFIG.overviewPages.kitchen.end);
  sections.push("## Kitchen Gear");
  sections.push("");
  sections.push(kitchenText.trim());
  sections.push("");

  // Extract cooking techniques
  log("Extracting cooking techniques...");
  const techniquesText = await extractPageText(CONFIG.overviewPages.techniques.start, CONFIG.overviewPages.techniques.end);
  sections.push("## Cooking Techniques & FAQs");
  sections.push("");
  sections.push(techniquesText.trim());
  sections.push("");

  // Extract reference tables
  log("Extracting reference tables...");
  const referenceText = await extractPageText(runtimeReferenceRange.start, runtimeReferenceRange.end);
  sections.push("## Reference Tables");
  sections.push("");
  sections.push(referenceText.trim());
  sections.push("");

  const overviewPath = join(CONFIG.outputDir, "overview.md");
  writeFileSync(overviewPath, sections.join("\n"));

  progress.overviewComplete = true;
  saveProgress(progress);

  log(`Overview saved to ${overviewPath}`);
}

// ============================================================================
// Image Extraction and Matching
// ============================================================================

async function extractRecipeImage(photoPage: number, outputFilename: string): Promise<boolean> {
  const outputPath = join(CONFIG.imagesDir, outputFilename);

  if (existsSync(outputPath)) {
    return true; // Already extracted
  }

  try {
    // Extract page as high-quality JPEG
    const tempBase = join(CONFIG.outputDir, `temp_photo_${photoPage}`);
    const cmd = `pdftoppm -f ${photoPage} -l ${photoPage} -jpeg -r 200 "${CONFIG.pdfPath}" "${tempBase}"`;
    await runCommand(cmd);

    // Find the generated file
    const files = readdirSync(CONFIG.outputDir).filter(f => f.startsWith(`temp_photo_${photoPage}`));
    if (files.length > 0) {
      const tempFile = join(CONFIG.outputDir, files[0]);
      const buffer = readFileSync(tempFile);
      writeFileSync(outputPath, buffer);
      unlinkSync(tempFile);
      return true;
    }

    return false;
  } catch (error: any) {
    logError(`Failed to extract image for page ${photoPage}: ${error.message}`);
    return false;
  }
}

// ============================================================================
// Main Processing
// ============================================================================

// Recipe pages follow a pattern: even pages have recipes, odd pages have photos
// But we'll process directly and skip if parsing fails
function getRecipePageCandidates(startPage: number, endPage: number): number[] {
  const candidates: number[] = [];
  // Based on analysis: recipes start at page 47/48 and are on alternating pages
  // Start from 47 and try every odd page first (since first recipe was at 48 = photo at 47)
  // Actually the pattern is: photo on odd, recipe on even (47=photo, 48=recipe)
  for (let page = 48; page <= endPage; page += 2) {
    if (page >= startPage) {
      candidates.push(page);
    }
  }
  return candidates;
}

function getIncrementalRecipeStartPage(progress: Progress): number {
  const processedRecipePages = progress.pagesProcessed.filter(page => page >= CONFIG.recipeStartPage && page % 2 === 0);
  const maxProcessedPage = processedRecipePages.length > 0
    ? Math.max(...processedRecipePages)
    : CONFIG.recipeStartPage - 2;
  const currentPage = progress.currentPage && progress.currentPage > 0
    ? progress.currentPage
    : CONFIG.recipeStartPage;
  const normalizedCurrentPage = currentPage % 2 === 0 ? currentPage : currentPage + 1;
  const startPage = Math.max(CONFIG.recipeStartPage, maxProcessedPage + 2, normalizedCurrentPage);
  return startPage % 2 === 0 ? startPage : startPage + 1;
}

async function processRecipe(
  recipePage: number,
  photoPage: number,
  progress: Progress
): Promise<boolean> {
  try {
    log(`Processing page ${recipePage}...`);

    const recipe = await parseRecipePage(recipePage);
    if (!recipe) {
      log(`  Page ${recipePage} is not a recipe page, skipping...`);
      return false;
    }

    // Validate recipe has required fields
    if (!recipe.name || !recipe.ingredients || recipe.ingredients.length === 0) {
      log(`  Page ${recipePage} parsed but missing required fields, skipping...`);
      return false;
    }

    // Generate filename
    const categorySlug = getCategorySlug(recipe.category || "uncategorized");
    const nameSlug = slugify(recipe.name);
    const filename = `${categorySlug}__${nameSlug}`;

    // Check if already processed
    if (progress.recipesProcessed.includes(filename)) {
      log(`  Recipe ${filename} already processed, skipping...`);
      progress.pagesProcessed.push(recipePage);
      saveProgress(progress);
      return true;
    }

    log(`  Found: ${recipe.name} (${recipe.category || "Unknown"})`);

    // Extract photo
    const imageFilename = `${filename}.jpg`;
    const hasImage = await extractRecipeImage(photoPage, imageFilename);

    // Generate markdown
    const markdown = generateRecipeMarkdown(recipe, hasImage ? imageFilename : null);

    // Save markdown file
    const mdPath = join(CONFIG.recipesDir, `${filename}.md`);
    writeFileSync(mdPath, markdown);

    // Update progress
    progress.recipesProcessed.push(filename);
    progress.pagesProcessed.push(recipePage);
    progress.pagesProcessed.push(photoPage);
    progress.totalRecipes = progress.recipesProcessed.length;
    progress.currentPage = recipePage + 1;
    saveProgress(progress);

    log(`  Saved: ${filename}.md`);
    return true;
  } catch (error: any) {
    logError(`Failed to process page ${recipePage}: ${error.message}`);
    progress.errors.push({
      page: recipePage,
      error: error.message,
      timestamp: new Date().toISOString()
    });
    saveProgress(progress);
    return false;
  }
}

async function processAllRecipes(progress: Progress): Promise<void> {
  log("Starting recipe processing...");
  log(`Current progress: ${progress.recipesProcessed.length} recipes processed`);

  const startPage = getIncrementalRecipeStartPage(progress);
  const candidates = getRecipePageCandidates(startPage, runtimeRecipeEndPage);
  const toProcess = candidates.filter(page => !progress.pagesProcessed.includes(page));

  log(`Scanning recipe pages ${startPage}-${runtimeRecipeEndPage}`);
  log(`${toProcess.length} candidate pages to process (${candidates.length - toProcess.length} already done in this range)`);

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const recipePage of toProcess) {
    const photoPage = recipePage - 1;

    const success = await processRecipe(recipePage, photoPage, progress);
    if (success) {
      processed++;
    } else {
      // Mark page as processed even if failed so we don't retry
      if (!progress.pagesProcessed.includes(recipePage)) {
        progress.pagesProcessed.push(recipePage);
        saveProgress(progress);
      }
      failed++;
    }

    // Log progress every 10 recipes
    if ((processed + failed) % 10 === 0) {
      log(`Progress: ${processed} processed, ${failed} failed, ${toProcess.length - processed - failed} remaining`);
    }
  }

  log(`Recipe processing complete: ${processed} processed, ${failed} failed`);
}

// ============================================================================
// Re-parse Single Recipe (for fixing issues)
// ============================================================================

async function reparseRecipe(pages: number[], outputName?: string): Promise<void> {
  log(`Re-parsing recipe from pages: ${pages.join(", ")}`);

  if (pages.length === 0) {
    logError("No pages specified");
    return;
  }

  // Sort pages and determine photo vs recipe pages
  const sortedPages = [...pages].sort((a, b) => a - b);

  // For multi-page recipes, combine images
  const imageBuffers: string[] = [];
  for (const page of sortedPages) {
    log(`  Extracting page ${page}...`);
    const base64 = await getPageImageBase64(page);
    imageBuffers.push(base64);
  }

  // Send all pages to Gemini for parsing
  const recipe = await parseMultiPageRecipe(imageBuffers, sortedPages);

  if (!recipe) {
    logError("Failed to parse recipe from provided pages");
    return;
  }

  log(`  Parsed: ${recipe.name} (${recipe.category})`);
  log(`  Macros: ${recipe.macros.calories} cal, ${recipe.macros.fat} fat, ${recipe.macros.carbs} carbs, ${recipe.macros.protein} protein`);

  // Generate filename
  const categorySlug = getCategorySlug(recipe.category || "uncategorized");
  const nameSlug = slugify(recipe.name);
  const filename = outputName || `${categorySlug}__${nameSlug}`;

  // Extract photo from first page (usually the photo page)
  const photoPage = sortedPages[0];
  const imageFilename = `${filename}.jpg`;
  await extractRecipeImage(photoPage, imageFilename);

  // Generate and save markdown
  const markdown = generateRecipeMarkdown(recipe, imageFilename);
  const mdPath = join(CONFIG.recipesDir, `${filename}.md`);
  writeFileSync(mdPath, markdown);

  log(`  Saved: ${filename}.md`);

  // Update progress
  const progress = loadProgress();
  if (!progress.recipesProcessed.includes(filename)) {
    progress.recipesProcessed.push(filename);
    progress.totalRecipes = progress.recipesProcessed.length;
  }
  saveProgress(progress);
}

async function parseMultiPageRecipe(imageBuffers: string[], pageNumbers: number[]): Promise<Recipe | null> {
  // Build parts array with all images
  const parts: any[] = [
    {
      text: `Extract the recipe information from these ${imageBuffers.length} cookbook pages (pages ${pageNumbers.join(", ")}).

These pages together contain ONE recipe. Look across ALL pages to find:
- Recipe name (usually large text at top)
- Category (shown at bottom of recipe page, e.g., "Breakfast Bliss", "Dinner is Served")
- Serves/Prep/Cook times
- MACROS box (calories, fat, carbs, net carbs, protein) - THIS IS CRITICAL, find the macros box
- All ingredients with exact measurements
- All directions/steps
- Any tips or notes

The MACROS are usually in a colored box showing:
- CALORIES (a number like 361, 487, etc.)
- FAT (like "2G FAT" or "20G")
- CARBS (like "72G CARBS")
- NET CARBS (sometimes shown)
- PROTEIN (like "37G PROTEIN")

If you see "0" for macros but there are clearly real values shown, extract the REAL values.
Be thorough - check all pages for the complete recipe information.`
    }
  ];

  // Add all images
  for (const base64 of imageBuffers) {
    parts.push({
      inline_data: {
        mime_type: "image/png",
        data: base64
      }
    });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.geminiModel}:generateContent?key=${CONFIG.geminiApiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            response_mime_type: "application/json",
            response_schema: RECIPE_SCHEMA
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      throw new Error("Invalid response structure from Gemini");
    }

    return JSON.parse(data.candidates[0].content.parts[0].text) as Recipe;
  } catch (error: any) {
    logError(`Multi-page parse failed: ${error.message}`);
    return null;
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

function printUsage(): void {
  console.log(`
Diet Cheat Codes PDF Parser

Usage:
  bun run parse.ts <pdf-path>                    Process all recipes
  bun run parse.ts <pdf-path> --output-dir <dir> Process all recipes to a custom output directory
  bun run parse.ts <pdf-path> --reparse <pages>  Re-parse specific pages
  bun run parse.ts --help                        Show this help

Examples:
  bun run parse.ts "/path/to/Diet Cheat Codes 1526.pdf"
  bun run parse.ts "/path/to/Diet Cheat Codes 1526.pdf" --output-dir ./book-export
  bun run parse.ts "/path/to/Diet Cheat Codes 1526.pdf" --reparse 47,48
                                              Re-parse pages 47-48 as single recipe
  bun run parse.ts "/path/to/Diet Cheat Codes 1526.pdf" --reparse 121,122,123
                                              Re-parse multi-page recipe
  bun run parse.ts "/path/to/Diet Cheat Codes 1526.pdf" --reparse 72 --name breakfast-bliss__lemon-glaze-muffins
                                              Re-parse and save with specific name

Options:
  <pdf-path>          Path to the Diet Cheat Codes PDF file
  --output-dir <dir>  Output directory (default: current working directory)
  --reparse <pages>   Comma-separated list of page numbers to re-parse
  --name <filename>   Output filename (without .md extension)
  --help              Show this help message
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Check for help
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const outputDirIndex = args.indexOf('--output-dir');
  if (outputDirIndex !== -1 && !args[outputDirIndex + 1]) {
    logError('--output-dir requires a directory path');
    process.exit(1);
  }

  const outputDirArg = outputDirIndex !== -1
    ? args[outputDirIndex + 1]
    : process.cwd();

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

  CONFIG.pdfPath = pdfPath;
  await initializePdfLayout();

  // Check for reparse mode
  const reparseIndex = args.indexOf("--reparse");
  if (reparseIndex !== -1) {
    const pagesArg = args[reparseIndex + 1];
    if (!pagesArg) {
      logError("--reparse requires page numbers (e.g., --reparse 47,48)");
      process.exit(1);
    }

    const pages = pagesArg.split(",").map(p => parseInt(p.trim())).filter(p => !isNaN(p));
    if (pages.length === 0) {
      logError("Invalid page numbers");
      process.exit(1);
    }

    // Check for custom output name
    const nameIndex = args.indexOf("--name");
    const outputName = nameIndex !== -1 ? args[nameIndex + 1] : undefined;

    // Ensure directories exist
    mkdirSync(CONFIG.outputDir, { recursive: true });
    mkdirSync(CONFIG.recipesDir, { recursive: true });
    mkdirSync(CONFIG.imagesDir, { recursive: true });

    await reparseRecipe(pages, outputName);
    return;
  }

  // Default: full processing mode
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Diet Cheat Codes PDF Parser");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Output directory: ${CONFIG.outputDir}`);
  console.log("");

  // Ensure directories exist
  mkdirSync(CONFIG.outputDir, { recursive: true });
  mkdirSync(CONFIG.recipesDir, { recursive: true });
  mkdirSync(CONFIG.imagesDir, { recursive: true });

  // Load or create progress
  const progress = loadProgress();

  log(`Loaded progress: ${progress.recipesProcessed.length} recipes already processed`);

  // Setup graceful shutdown
  process.on("SIGINT", () => {
    log("Received SIGINT, saving progress...");
    saveProgress(progress);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    log("Received SIGTERM, saving progress...");
    saveProgress(progress);
    process.exit(0);
  });

  try {
    // Step 1: Generate overview if not done
    await generateOverview(progress);

    // Step 2: Process all recipes
    await processAllRecipes(progress);

    // Final summary
    console.log("");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log("  Processing Complete!");
    console.log("═══════════════════════════════════════════════════════════════");
    console.log(`  Total recipes processed: ${progress.totalRecipes}`);
    console.log(`  Errors encountered: ${progress.errors.length}`);
    console.log(`  Output directory: ${CONFIG.outputDir}`);
    console.log("═══════════════════════════════════════════════════════════════");

  } catch (error: any) {
    logError(`Fatal error: ${error.message}`);
    saveProgress(progress);
    process.exit(1);
  }
}

// Run
main();
