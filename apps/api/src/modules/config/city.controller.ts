import { Controller, Get, Inject, Injectable } from '@nestjs/common';
import { cityListSchema, type City } from '@sepehr/contracts';
import { sql } from 'drizzle-orm';
import { Public } from '../../common/auth/auth.decorators';
import { ZodResponse } from '../../common/zod-response';
import { DATABASE, type Database } from '../../db/database.module';

/** The cities (ADR-010), read only: migrations fill the table (0020). */
@Injectable()
export class CityService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(): Promise<City[]> {
    const { rows } = await this.db.execute(sql`
      SELECT code, name, active FROM cities
      WHERE deleted_at IS NULL
      ORDER BY sort_order, name
    `);
    return rows.map((r) => ({
      code: String(r['code']),
      name: String(r['name']),
      active: r['active'] === true,
    }));
  }
}

/** Public, like the treatment fields: pages show city names and the search offers them. */
@Controller('config/cities')
export class CityController {
  constructor(private readonly cities: CityService) {}

  @Public()
  @Get()
  @ZodResponse(cityListSchema)
  list() {
    return this.cities.list();
  }
}
