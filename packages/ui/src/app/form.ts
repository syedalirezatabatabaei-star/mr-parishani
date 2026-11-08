/** A text field of a submitted form, or '' (a file or a missing field is not text). */
export function formText(form: HTMLFormElement | FormData, name: string): string {
  const value = (form instanceof FormData ? form : new FormData(form)).get(name);
  return typeof value === 'string' ? value : '';
}
