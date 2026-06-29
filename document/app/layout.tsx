import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'CHRONOS Observatory | Solana AI Transaction Intelligence',
  description: 'A CTO-oriented walkthrough of CHRONOS, an AI-guided Solana/Jito transaction observability system.'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
