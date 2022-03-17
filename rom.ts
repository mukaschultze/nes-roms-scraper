export interface ROM {
  id: string;
  title: string;
  emulator: string;
  thumbnail: string;
  extras: Extras;
}

export interface Extras {
  itemListElement: string;
  item: string;
  name: string;
  position: string;
  url: string;
  applicationCategory: string;
  image: string;
  operatingSystem: string;
  genre: string;
  fileSize: string;
  gameLocation: string;
  downloadUrl: string;
  description: string;
  aggregateRating: string;
  bestRating: string;
  ratingValue: string;
  reviewCount: string;
}
