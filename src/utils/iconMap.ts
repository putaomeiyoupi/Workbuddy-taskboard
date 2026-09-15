import type { ComponentType, SVGProps } from 'react';
import {
  Bot,
  Code,
  Globe,
  Sparkles,
  FileText,
  Lightbulb
} from 'lucide-react';

/** 图标组件类型：兼容 lucide 的 ForwardRefExoticComponent */
export type IconComponent = ComponentType<
  SVGProps<SVGSVGElement> & { size?: number | string }
>;

// Icon 映射
export const ICON_MAP: Record<string, IconComponent> = {
  Bot,
  Sparkles,
  Code,
  FileText,
  Globe,
  Lightbulb,
};
