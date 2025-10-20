// app/lib/weather-advice.ts
export type AdviceInput = {
temp: number;
feels?: number;
wind?: number; // m/s
rain?: number; // mm/1h 或 3h
snow?: number; // mm/1h 或 3h
humidity?: number; // %
};


export function outfitAdvice({ temp, feels, wind, rain, snow }: AdviceInput): string {
const t = Number.isFinite(feels) ? (feels as number) : temp;
const wet = (rain ?? 0) > 0 || (snow ?? 0) > 0;
const parts: string[] = [];


if (t >= 33) parts.push('酷熱，清爽短袖/排汗材質，防曬補水');
else if (t >= 30) parts.push('很熱，透氣短袖，避免長時間曝曬');
else if (t >= 25) parts.push('偏熱，短袖為主，通風透氣');
else if (t >= 20) parts.push('舒適，短袖或薄長袖皆宜');
else if (t >= 15) parts.push('微涼，建議薄外套/薄針織');
else if (t >= 10) parts.push('偏涼，長袖+外套');
else if (t >= 5) parts.push('寒冷，保暖外套/內搭');
else parts.push('嚴寒，厚外套、帽子手套圍巾');


if ((wind ?? 0) >= 8) parts.push('風大，使用防風外套');
if (wet) parts.push('可能降水，攜帶摺疊傘/防水外層');


return parts.join('；') + '。';
}