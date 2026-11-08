import { redirect } from 'next/navigation';

/** «مدیریت محتوای پیشخوان» opens on its banners. */
export default function ContentHome() {
  redirect('/content/banners');
}
