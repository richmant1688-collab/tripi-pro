
export const metadata = { title: 'Tripi Pro — AI Travel Navigator', description: 'Smart trip planning with interactive maps' };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  );
}
