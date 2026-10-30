// Server-side messages in the visitor's language (Persian by default).
// The browser sends its chosen language in the X-Lang header.

const MESSAGES = {
  en: {
    login_required: 'Please log in first.',
    invalid_login: 'Enter a valid email address or mobile number.',
    short_password: 'Password must be at least 8 characters.',
    account_exists: 'An account already exists for this login. Please log in.',
    wrong_credentials: 'Wrong login or password.',
    unknown_plan: 'Unknown subscription plan.',
    payments_unavailable: 'Payments are not configured yet.',
    gateway_error: 'Could not reach the payment gateway.',
    subscription_required: 'This feature requires a subscription.',
    empty_text: 'Please enter some text.',
    text_too_long: 'Text is limited to {max} characters.',
    unknown_voice: 'That voice is not available.',
    tts_failed: 'Speech generation failed.',
    tts_unavailable: 'The text-to-speech service is unavailable.',
    generation_unavailable: 'Character generation is not set up yet.',
    bad_photo: 'Please send a JPEG, PNG or WebP photo.',
    daily_cap: 'We have reached today\'s limit for new characters. Please try again tomorrow.',
    subscriber_limit: 'You can create up to {limit} characters per day.',
    free_limit: 'Free visitors can create {limit} characters per day. Subscribe for more.',
    generation_in_progress: 'Your character is already being created.',
    generation_blocked: 'We could not turn this photo into a character. Please try a clear, front-facing photo.',
    generation_failed: 'Character generation failed. Please try again.',
    too_many_requests: 'Too many requests. Please try again a little later.',
    unsupported_type: 'Unsupported content type.',
    not_found: 'Not found.',
    internal_error: 'Internal server error.',
  },
  fa: {
    login_required: 'ابتدا وارد حساب کاربری شوید.',
    invalid_login: 'ایمیل یا شماره موبایل معتبر وارد کنید.',
    short_password: 'رمز عبور باید حداقل ۸ کاراکتر باشد.',
    account_exists: 'این حساب قبلاً ساخته شده است. وارد شوید.',
    wrong_credentials: 'نام کاربری یا رمز عبور اشتباه است.',
    unknown_plan: 'طرح اشتراک نامعتبر است.',
    payments_unavailable: 'درگاه پرداخت هنوز تنظیم نشده است.',
    gateway_error: 'اتصال به درگاه پرداخت ناموفق بود.',
    subscription_required: 'برای این قابلیت باید اشتراک تهیه کنید.',
    empty_text: 'متنی وارد نشده است.',
    text_too_long: 'حداکثر {max} کاراکتر مجاز است.',
    unknown_voice: 'صدای انتخاب‌شده موجود نیست.',
    tts_failed: 'تولید صدا ناموفق بود.',
    tts_unavailable: 'سرویس تبدیل متن به گفتار در دسترس نیست.',
    generation_unavailable: 'ساخت شخصیت هنوز راه‌اندازی نشده است.',
    bad_photo: 'لطفاً یک عکس JPEG، PNG یا WebP بفرستید.',
    daily_cap: 'ظرفیت ساخت شخصیت برای امروز تمام شده است. لطفاً فردا دوباره امتحان کنید.',
    subscriber_limit: 'روزانه حداکثر {limit} شخصیت می‌توانید بسازید.',
    free_limit: 'کاربران رایگان روزانه {limit} شخصیت می‌توانند بسازند. برای ساخت بیشتر اشتراک تهیه کنید.',
    generation_in_progress: 'شخصیت شما در حال ساخت است.',
    generation_blocked: 'از این عکس نتوانستیم شخصیت بسازیم. لطفاً یک عکس واضح و روبه‌رو امتحان کنید.',
    generation_failed: 'ساخت شخصیت ناموفق بود. دوباره تلاش کنید.',
    too_many_requests: 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.',
    unsupported_type: 'نوع درخواست پشتیبانی نمی‌شود.',
    not_found: 'پیدا نشد.',
    internal_error: 'خطای داخلی سرور.',
  },
};

export function langMiddleware(req, _res, next) {
  const header = String(req.get('x-lang') || '').toLowerCase();
  req.lang = MESSAGES[header] ? header : req.acceptsLanguages('fa', 'en') || 'fa';
  next();
}

export function msg(req, key, vars = {}) {
  const lang = MESSAGES[req.lang] ? req.lang : 'fa';
  const fmt = new Intl.NumberFormat(lang === 'fa' ? 'fa-IR' : 'en-US');
  return (MESSAGES[lang][key] || MESSAGES.en[key] || key)
    .replace(/\{(\w+)\}/g, (_, k) => (typeof vars[k] === 'number' ? fmt.format(vars[k]) : String(vars[k] ?? '')));
}
