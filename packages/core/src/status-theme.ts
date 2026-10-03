import type { StatusSettings } from './status';

/* Schema defaults (status.ts). A color equal to its default was never customized, so the
   public page falls back to the built-in RECIAM palette instead. */
export const statusDesignDefaults = {
  accentColor: '#00856a',
  backgroundColor: '#f6f8f7',
  surfaceColor: '#ffffff',
  textColor: '#243d35',
  cornerRadius: 16,
} as const;

/* RECIAM Paper and Dark tokens the public page uses when a color is not customized. */
const builtInPalettes = {
  light: { background: '#f7f1e3', surface: '#fffcf5', text: '#14262e' },
  dark: { background: '#0a0b0c', surface: '#101214', text: '#f4efe3' },
};

export type StatusPalette = { background: string; surface: string; text: string };
type DesignFields = Pick<
  StatusSettings,
  | 'theme'
  | 'backgroundColor'
  | 'surfaceColor'
  | 'textColor'
  | 'darkBackgroundColor'
  | 'darkSurfaceColor'
  | 'darkTextColor'
>;

export function customizedColor(value: string | undefined, fallback: string) {
  return value && value.toLowerCase() !== fallback ? value : undefined;
}

/** The colors a visitor actually sees in each theme. */
export function statusPalettes(settings: DesignFields): Record<'light' | 'dark', StatusPalette> {
  return {
    light: {
      background:
        customizedColor(settings.backgroundColor, statusDesignDefaults.backgroundColor) ??
        builtInPalettes.light.background,
      surface:
        customizedColor(settings.surfaceColor, statusDesignDefaults.surfaceColor) ??
        builtInPalettes.light.surface,
      text:
        customizedColor(settings.textColor, statusDesignDefaults.textColor) ??
        builtInPalettes.light.text,
    },
    dark: {
      background: settings.darkBackgroundColor || builtInPalettes.dark.background,
      surface: settings.darkSurfaceColor || builtInPalettes.dark.surface,
      text: settings.darkTextColor || builtInPalettes.dark.text,
    },
  };
}

function luminance(hex: string) {
  return [1, 3, 5].reduce((total, offset, index) => {
    const s = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    const linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    return total + linear * [0.2126, 0.7152, 0.0722][index]!;
  }, 0);
}

/** WCAG 2 contrast ratio between two #rrggbb colors (1–21). */
export function contrastRatio(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

export type ContrastIssue = {
  theme: 'light' | 'dark';
  against: 'background' | 'surface';
  ratio: number;
};

/** Text/background pairs below WCAG AA (4.5:1) in the themes visitors can see. */
export function statusContrastIssues(settings: DesignFields): ContrastIssue[] {
  const palettes = statusPalettes(settings);
  const themes =
    settings.theme === 'auto' ? (['light', 'dark'] as const) : ([settings.theme] as const);
  return themes.flatMap((theme) =>
    (['background', 'surface'] as const)
      .map((against) => ({
        theme,
        against,
        ratio: contrastRatio(palettes[theme].text, palettes[theme][against]),
      }))
      .filter((issue) => issue.ratio < 4.5),
  );
}

export type StatusPreset = {
  name: string;
  description: string;
  settings: Pick<
    StatusSettings,
    | 'theme'
    | 'font'
    | 'cornerRadius'
    | 'accentColor'
    | 'backgroundColor'
    | 'surfaceColor'
    | 'textColor'
    | 'darkBackgroundColor'
    | 'darkSurfaceColor'
    | 'darkTextColor'
  >;
};

export const statusPresets: StatusPreset[] = [
  {
    name: 'StillUp',
    description: 'The built-in palette, following each visitor’s system theme',
    settings: {
      theme: 'auto',
      font: 'sans',
      ...statusDesignDefaults,
      darkBackgroundColor: '',
      darkSurfaceColor: '',
      darkTextColor: '',
    },
  },
  {
    name: 'Ocean',
    description: 'Crisp blues, light or dark',
    settings: {
      theme: 'auto',
      font: 'system',
      cornerRadius: 6,
      accentColor: '#2563eb',
      backgroundColor: '#f3f6fb',
      surfaceColor: '#ffffff',
      textColor: '#1b2a41',
      darkBackgroundColor: '#0a1422',
      darkSurfaceColor: '#10203a',
      darkTextColor: '#e3ecf8',
    },
  },
  {
    name: 'Editorial',
    description: 'Warm paper and serif type',
    settings: {
      theme: 'light',
      font: 'serif',
      cornerRadius: 2,
      accentColor: '#b4532a',
      backgroundColor: '#f7f3ea',
      surfaceColor: '#fffdf8',
      textColor: '#2b2620',
      darkBackgroundColor: '',
      darkSurfaceColor: '',
      darkTextColor: '',
    },
  },
  {
    name: 'Graphite',
    description: 'Neutral and understated',
    settings: {
      theme: 'light',
      font: 'system',
      cornerRadius: 4,
      accentColor: '#475569',
      backgroundColor: '#f4f4f5',
      surfaceColor: '#ffffff',
      textColor: '#18181b',
      darkBackgroundColor: '',
      darkSurfaceColor: '',
      darkTextColor: '',
    },
  },
  {
    name: 'Midnight',
    description: 'Deep navy with a periwinkle accent',
    settings: {
      theme: 'dark',
      font: 'sans',
      cornerRadius: 6,
      accentColor: '#7c9cff',
      backgroundColor: statusDesignDefaults.backgroundColor,
      surfaceColor: statusDesignDefaults.surfaceColor,
      textColor: statusDesignDefaults.textColor,
      darkBackgroundColor: '#0b1020',
      darkSurfaceColor: '#131a2e',
      darkTextColor: '#e6e9f2',
    },
  },
  {
    name: 'Terminal',
    description: 'Monospace on near-black',
    settings: {
      theme: 'dark',
      font: 'mono',
      cornerRadius: 0,
      accentColor: '#3ddc84',
      backgroundColor: statusDesignDefaults.backgroundColor,
      surfaceColor: statusDesignDefaults.surfaceColor,
      textColor: statusDesignDefaults.textColor,
      darkBackgroundColor: '#0c0f0c',
      darkSurfaceColor: '#121712',
      darkTextColor: '#d7f5dd',
    },
  },
];
