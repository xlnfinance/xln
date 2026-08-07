import {
	Activity,
	ArrowDown,
	ArrowLeftRight,
	ArrowUp,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	Copy,
	Home,
	Landmark,
	Lock,
	Moon,
	Scale,
	Settings,
	ShieldCheck,
	Sun,
	Users,
	X,
} from 'lucide-react';

export const icons = {
	home: Home,
	accounts: Users,
	swap: ArrowLeftRight,
	activity: Activity,
	settings: Settings,
	pay: ArrowUp,
	request: ArrowDown,
	settle: Scale,
	shield: ShieldCheck,
	copy: Copy,
	check: Check,
	close: X,
	chevronDown: ChevronDown,
	chevronLeft: ChevronLeft,
	chevronRight: ChevronRight,
	lock: Lock,
	sun: Sun,
	moon: Moon,
	bank: Landmark,
} as const;

export type IconName = keyof typeof icons;

export function Icon({ name, size = 17, strokeWidth = 1.6 }: { name: IconName; size?: number; strokeWidth?: number }) {
	const Component = icons[name];
	return <Component size={size} strokeWidth={strokeWidth} aria-hidden />;
}
