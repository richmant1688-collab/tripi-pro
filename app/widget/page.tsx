// app/widget/page.tsx
import dynamic from 'next/dynamic';

const WidgetClient = dynamic(() => import('./WidgetClient'), { ssr: false });

export default function Page() {
  return <WidgetClient />;
}
