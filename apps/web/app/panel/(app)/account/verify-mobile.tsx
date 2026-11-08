'use client';

import { VerifyMobile as Form } from '@sepehr/ui';
import { useRouter } from 'next/navigation';

/** Two steps: the mobile, then the code sent to it (task 4-6, owner: by OTP only). */
export function VerifyMobile({ verified }: { verified: boolean }) {
  const router = useRouter();
  return (
    <Form
      verified={verified}
      onVerified={() => {
        router.refresh();
      }}
    />
  );
}
