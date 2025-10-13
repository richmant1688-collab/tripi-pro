// app/page.tsx
import dynamic from 'next/dynamic';

const HomeClient = dynamic(() => import('./HomeClient'), { ssr: false });

export default function Page() {
  return <HomeClient />;
}